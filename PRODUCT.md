# X-Ecommerce

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

用户指定 MySQL。前后端采用本轮提议的 React + TypeScript / Node.js；交付团队自用的本机版本及 app、worker、MySQL Docker 部署包。

## Users

跨境电商经营者与内容团队；用户本人希望掌握经营场景并构建核心选品和经营自动化工具。

## Product Purpose

基于 EchoTik 实现与 Clipcat 对应的研究、内容生产和发布工作流。支持发现商品/视频、评论研究、提示词库、视频分析、复刻、商品转视频、图像生成、超分、角色、素材、任务、发布与分析。

## Capabilities and Constraints

EchoTik 提供公开市场与历史商业数据；部分 GMV 为预估，未收录不等于零。凭证只在后端使用。用户暂未购买生成服务或申请 TikTok 应用，要求先实现可配置接入。不能将未调用供应商的任务标为成功，不能伪造高 GMV 案例库。面向团队的多工作空间与权限隔离；计量默认关闭，不扩展订单、库存、采购 ERP 或对外收费 SaaS。研究允许自动运行；生成、超分与发布需要人工确认。

## Brand Commitments

用户命名 X- Ecommerce，代码与界面使用 X-Ecommerce。以已保存的 Clipcat 界面和功能为明确参考，保留工作台、侧边导航及对应页面结构；使用自己的品牌与实现。

## Evidence on Hand

research/clipcat-ui-2026-10-19 保存 12 页截图/DOM/MHTML；research/clipcat-rea-2026-10-19 保存接口与实现证据；research/echotik-api-2026-10-19 保存数据、价格和许可调查。

## Product Principles

- 每项外部数据保留来源、窗口、采集时间及估算状态。
- 本地可用的素材、角色、草稿、收藏和任务持久化到 MySQL。
- 真实调用才产生真实结果；缺少凭证必须可见。
- 从候选商品的证据连接到可拍摄脚本和创作任务。
