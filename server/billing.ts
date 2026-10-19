import express, { Router } from "express";
import Stripe from "stripe";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { rows, execute } from "./db.ts";
import { workspace } from "./context.ts";
import { wallet, ledger, setMetered, grantCredits } from "./credits.ts";
import { requireOwner, requirePlatformAdmin, audit } from "./auth.ts";
import { AppError } from "./errors.ts";
export const packs = () =>
  z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        priceId: z.string().startsWith("price_"),
        credits: z.number().int().positive(),
        mode: z.enum(["payment", "subscription"]).default("payment"),
      }),
    )
    .parse(JSON.parse(process.env.BILLING_PACKS_JSON || "[]"));
const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new AppError(
      409,
      "尚未配置 Stripe 支付服务",
      "PROVIDER_NOT_CONFIGURED",
    );
  return new Stripe(process.env.STRIPE_SECRET_KEY);
};
export const billingRoutes = Router();
billingRoutes.get("/billing", async (_req, res) =>
  res.json({
    wallet: await wallet(),
    ledger: await ledger(),
    packs: packs().map(({ priceId, ...p }) => p),
    checkoutAvailable: !!process.env.STRIPE_SECRET_KEY,
  }),
);
billingRoutes.put("/billing/metering", async (req, res) => {
  requirePlatformAdmin();
  const enabled = z.boolean().parse(req.body.enabled);
  res.json(await setMetered(enabled));
  await audit("credits.metering", { enabled });
});
billingRoutes.post("/billing/grant", async (req, res) => {
  requirePlatformAdmin();
  const b = z
    .object({
      units: z.number().int().positive().max(100000000),
      reference: z.string().min(8).max(120),
      note: z.string().max(255).default("管理员发放"),
    })
    .parse(req.body);
  await grantCredits(b.units, "admin:" + b.reference, b.note);
  await audit("credits.granted", { units: b.units, reference: b.reference });
  res.json(await wallet());
});
billingRoutes.get("/billing/orders", async (_req, res) =>
  res.json(
    await rows(
      "SELECT id,session_id,price_id,units,status,created_at FROM billing_orders WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100",
      [workspace()],
    ),
  ),
);
billingRoutes.post("/billing/checkout", async (req, res) => {
  requireOwner();
  const b = z
    .object({ packId: z.string(), requestId: z.string().min(8).max(80) })
    .parse(req.body);
  const pack = packs().find((p) => p.id === b.packId);
  if (!pack) throw new AppError(400, "套餐不存在");
  const base = new URL(process.env.APP_PUBLIC_URL || "http://localhost:4317");
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw new AppError(400, "支付回跳地址必须为 HTTPS");
  const id = createHash("sha256")
    .update(workspace() + ":" + b.requestId)
    .digest("hex");
  const [prior] = await rows(
    "SELECT * FROM billing_orders WHERE id=? AND workspace_id=?",
    [id, workspace()],
  );
  if (prior && prior.price_id !== pack.priceId)
    throw new AppError(409, "该请求标识已用于其他套餐");
  if (prior?.session_id) {
    const existing = await stripe().checkout.sessions.retrieve(
      prior.session_id,
    );
    return res.json({ url: existing.url, orderId: id });
  }
  await execute(
    "INSERT IGNORE INTO billing_orders(id,workspace_id,price_id,units,status) VALUES(?,?,?,?,'creating')",
    [id, workspace(), pack.priceId, pack.credits],
  );
  try {
    const metadata = {
      workspaceId: workspace(),
      credits: String(pack.credits),
      orderId: id,
    };
    const session = await stripe().checkout.sessions.create(
      {
        mode: pack.mode,
        line_items: [{ price: pack.priceId, quantity: 1 }],
        success_url: base.origin + "/billing?checkout=success",
        cancel_url: base.origin + "/billing?checkout=cancelled",
        metadata,
        ...(pack.mode === "subscription"
          ? { subscription_data: { metadata } }
          : {}),
      },
      { idempotencyKey: workspace() + ":" + b.requestId },
    );
    await execute(
      "UPDATE billing_orders SET session_id=?,status='pending' WHERE id=?",
      [session.id, id],
    );
    res.json({ url: session.url, orderId: id });
  } catch (e) {
    await execute("UPDATE billing_orders SET status='failed' WHERE id=?", [id]);
    throw e;
  }
});
export const stripeWebhook = express.Router();
stripeWebhook.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET)
      throw new AppError(409, "Stripe webhook 尚未配置");
    let event: Stripe.Event;
    try {
      event = stripe().webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"] as string,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      throw new AppError(400, "Stripe webhook 签名无效");
    }
    if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ].includes(event.type)
    ) {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode === "payment" && s.payment_status === "paid") {
        const [o] = await rows(
          "SELECT * FROM billing_orders WHERE session_id=?",
          [s.id],
        );
        if (o) {
          await grantCredits(
            Number(o.units),
            "stripe:session:" + s.id,
            "Stripe 购买额度",
            o.workspace_id,
          );
          await execute("UPDATE billing_orders SET status='paid' WHERE id=?", [
            o.id,
          ]);
        }
      }
    }
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as any;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.parent?.subscription_details?.subscription;
      if (subscriptionId) {
        const sub = await stripe().subscriptions.retrieve(subscriptionId);
        const ws = sub.metadata.workspaceId;
        const credit = Number(sub.metadata.credits);
        if (ws && Number.isSafeInteger(credit) && credit > 0) {
          await grantCredits(
            credit,
            "stripe:invoice:" + invoice.id,
            "Stripe 订阅周期额度",
            ws,
          );
          await execute("UPDATE billing_orders SET status='paid' WHERE id=?", [
            sub.metadata.orderId,
          ]);
        }
      }
    }
    if (event.type === "checkout.session.expired") {
      const s = event.data.object as Stripe.Checkout.Session;
      await execute(
        "UPDATE billing_orders SET status='expired' WHERE session_id=? AND status='pending'",
        [s.id],
      );
    }
    res.json({ received: true });
  },
);
