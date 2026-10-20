# X-Ecommerce 部署、升级与恢复

当前交付包含 Web/API、独立任务进程、MySQL 8.4 和本地/S3 素材存储。容器内使用 Node.js 22、系统 FFmpeg/FFprobe、libass 和 Noto CJK 字体；中文字幕烧录无需生成模型密钥。运行镜像包含 TypeScript 执行器，因此保留了构建依赖。

## 首次部署

仓库有两个 Compose 文件：`compose.yaml` 是原有开发数据库（localhost:3308，卷 `x_mysql`）；`docker-compose.yml` 是完整部署。完整部署命令必须显式带 `-f docker-compose.yml`。两套使用不同的 MySQL 卷，不会把现有本地数据库当作空库重新初始化。

在仓库根目录创建专用配置，生成随机值且不输出密钥：

```sh
mkdir -p .local
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const values = {
  MYSQL_DATABASE: 'x_ecommerce',
  MYSQL_USER: 'x_ecommerce',
  MYSQL_PASSWORD: randomBytes(32).toString('hex'),
  MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex'),
  X_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  APP_PORT: '4317',
  APP_PUBLIC_URL: 'http://localhost:4317',
  X_ALLOWED_HOSTS: 'localhost,127.0.0.1',
  COOKIE_SECURE: 'false',
  TIKTOK_REDIRECT_URI: 'http://localhost:4317/api/tiktok/callback',
};
writeFileSync('.local/deploy.env', Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n')+'\n', {flag:'wx',mode:0o600});
JS
docker compose --env-file .local/deploy.env -f docker-compose.yml up -d --build
docker compose --env-file .local/deploy.env -f docker-compose.yml ps
```

打开 `http://localhost:4317`，首次使用时创建平台管理员。随后在连接设置中配置 EchoTik、Gemini、Kie.ai/fal.ai、TikTok 应用与下载解析服务；这些值按工作空间加密保存。未配置的外部能力会明确报缺少连接，本地字幕、音频混合、封面和素材后期可以直接使用。

`app` 和 `worker` 挂载同一个 `application_data` 卷，并使用同一个 `X_ENCRYPTION_KEY`。该密钥必须长期保留：更换它会导致已有供应商凭证和 TikTok token 无法解密。MySQL 的初始化密码只在空卷创建时生效；修改 env 文件不会修改已有数据库账号密码。

应用端口只绑定主机 127.0.0.1，MySQL 不向主机开放端口。对外部署时配置 HTTPS 反向代理，并调整：

| 配置                  | 生产示例/说明                              |
| --------------------- | ------------------------------------------ |
| `APP_PUBLIC_URL`      | `https://commerce.example.com`             |
| `X_ALLOWED_HOSTS`     | `commerce.example.com`，多个主机用逗号分隔 |
| `COOKIE_SECURE`       | `true`；本机 HTTP 才使用 `false`           |
| `TIKTOK_REDIRECT_URI` | 与开发者平台登记的 HTTPS 回调完全一致      |
| `APP_PORT`            | 主机本地转发端口，默认 4317                |

反向代理应保留外部 `Host`，转发到 `127.0.0.1:4317`。平台账号保护默认开启。TikTok 公开发布仍取决于开发者应用权限、审核及已连接账号；本项目不会代替这些外部授权。

S3/R2 可通过 `STORAGE_DRIVER=s3`、`S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_FORCE_PATH_STYLE` 配置。开启支付另需 Stripe 配置。即使使用对象存储，也保留共享本地卷供上传暂存、视频后期和对象缓存使用。

## 健康检查与日志

```sh
docker compose --env-file .local/deploy.env -f docker-compose.yml logs --tail 100 app worker
docker compose --env-file .local/deploy.env -f docker-compose.yml exec app npm run health:worker
```

MySQL 检查可连接状态，app 检查 `/api/health`，worker 检查数据库中的独立任务进程心跳。worker 在长视频分析/本地渲染期间可能占用较长周期，容器检查默认允许 1,200 秒心跳间隔（脚本支持 `WORKER_HEALTH_MAX_AGE_SECONDS`）。健康状态只表示进程/基础依赖可用，外部 API Key、账户余额和发布权限应在平台内另行检查。`worker` 等待 `app` 首次迁移和健康检查完成后启动，避免空库并行迁移。

## 现有库升级

升级前等待正在运行的生成/发布任务结束，保留原镜像版本并做完整备份。MySQL 迁移包含保留旧数据的兼容升级、工作空间回填和版本记录；重复执行不会清空旧数据。

```sh
docker compose --env-file .local/deploy.env -f docker-compose.yml stop app worker
# 按下节备份后，再更新代码与构建。
docker compose --env-file .local/deploy.env -f docker-compose.yml build app
docker compose --env-file .local/deploy.env -f docker-compose.yml run --rm --no-deps app npm run db:migrate
docker compose --env-file .local/deploy.env -f docker-compose.yml up -d app worker
```

非 Docker 运行可在正确的 `.env.local`/`.env` 下执行 `npm run db:migrate`。自动迁移也会在 app/worker 启动时执行。没有破坏性自动降级：升级回滚应使用备份恢复到新数据库和新媒体目录，再切换旧版本应用。不要通过删除卷来修复迁移错误。

## 完整备份

备份含 gzip 数据快照、每个素材的原始字节、SHA-256 校验和及实际加密密钥。它包含账号资料和可解密供应商凭证，存放在仅管理员可读取的目录，并按自己的备份策略加密离线保存。脚本仅支持应用的基础表；自定义视图、触发器、存储过程或事件请改用 DBA 完整备份。

停止写入后备份，确保数据库和媒体是一致的。脚本还会获取任务进程锁，遇到活跃 worker 会拒绝备份。只有最终写出了 `complete:true` 的 `manifest.json` 才算成功；中断目录不会作为完整备份恢复。

```sh
docker compose --env-file .local/deploy.env -f docker-compose.yml stop app worker
docker compose --env-file .local/deploy.env -f docker-compose.yml run --rm --no-deps app npm run backup -- --out /app/.local/backups/release-001
# 复制到宿主机；目标目录应是未存在的私有路径。
docker compose --env-file .local/deploy.env -f docker-compose.yml cp app:/app/.local/backups/release-001 .local/release-001
docker compose --env-file .local/deploy.env -f docker-compose.yml up -d app worker
```

`compose cp` 也可读取已停止的 app 容器。备份路径必须是新目录；重新备份使用另一个名称。S3 模式会将被数据库引用的对象一并取回备份，因此需要可读的源桶凭证；缺少素材或无法读取对象将导致备份失败。

普通主机运行方式：停止 app/worker 后，使用当前运行目录和数据库/存储环境执行 `npm run backup -- --out /secure/new-backup-directory`。数据库快照逐行流式输出，不依赖宿主机安装 mysqldump。

## 恢复到新环境

恢复强制使用与源库不同的新库名，已有表的目标库会被拒绝，媒体目标目录也必须为空。脚本核对数据库、密钥、所有媒体的校验和，恢复后核对各表行数。恢复不会删除现有数据库，也不会自动启动 worker 或切换线上配置。

在独立恢复环境安装依赖、配置能创建新数据库的 MySQL 管理账号（或先由 DBA 创建空库并授权），然后运行：

```sh
npm run restore -- --from /secure/release-001 --database x_ecommerce_restored --local-dir /secure/restored-local
```

脚本使用与应用相同的 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`；从 `.env.local` 和 `.env` 加载，已存在的进程环境变量优先。恢复文件先完整验签，再创建新库。中途失败可能留下部分新库，需要检查或使用另一个新库名重试。

切换前执行这些步骤：

1. 使用 `MYSQL_DATABASE=x_ecommerce_restored`，将恢复后的 `restored-local` 映射为新应用的 `/app/.local`（主机运行则放在工作目录 `.local`）。容器默认以 node UID 1000 运行，新卷/目录应授予该账号读写权限。
2. 将备份内的 `encryption.key` 安全地恢复到部署密钥配置，或保留恢复生成的 `.local/master.key` 并确保没有其他 `X_ENCRYPTION_KEY` 覆盖。Compose 模板要求显式配置 `X_ENCRYPTION_KEY`，应设为备份32字节密钥的64位十六进制值。不要在终端共享日志中打印密钥。
3. 设置 `STORAGE_DRIVER=local`。恢复会将 S3 素材引用转为包含在备份中的本地文件，先验证完整素材；以后可再执行明确的存储迁移。
4. 保持 worker 停止，运行 `npm run db:migrate`，检查管理员登录、商品/项目数量、素材播放、已有视频、供应商配置解密。恢复包含原来的排程和任务，检查后再启用 worker，避免意外恢复旧排程。
5. 更新反向代理指向已验证的新环境，最后启动 worker。保留旧数据库与媒体卷供回退。

容器内恢复同样运行上述脚本；可用 `docker compose run --rm --no-deps app npm run restore -- ...`，并将备份和新的媒体目录挂载进去。数据库账号必须对目标新库有权限，不能仅有旧库授权。不要对未验证的目标环境执行线上流量切换。

## 管理员恢复

忘记管理员密码且无法由其他管理员重置时，拥有服务器和数据库权限的运维人员可生成一次性、一小时有效的恢复链接：

```sh
npm run admin:recovery -- --email admin@example.com --out /secure/admin-recovery.txt
# Docker：输出到共享卷，再安全取回文件。
docker compose --env-file .local/deploy.env -f docker-compose.yml exec app npm run admin:recovery -- --email admin@example.com --out /app/.local/admin-recovery.txt
```

脚本只接受已存在、未停用的平台管理员，记录审计日志并废止该用户旧的未使用重置链接。链接仅写入 0600 权限的新文件，不出现在脚本输出。通过配置的 `APP_PUBLIC_URL` 打开该链接完成密码重置，随后删除恢复文件。它不会创建管理员、跳过密码校验或更改工作空间归属。

## 可重复的验收

```sh
npm run test:deployment
```

该测试需要测试 MySQL 管理账号；默认使用 `npm run db:local` 产生的 `.local/mysql/root-password`，也支持 `MYSQL_ADMIN_USER` / `MYSQL_ADMIN_PASSWORD`。测试只创建带随机 `x_deploy_check_` 前缀的临时库，验证空库迁移、旧库数据保留、重复迁移、完整备份、异名恢复、BIGINT/DECIMAL/JSON/二进制/毫秒时间戳、媒体字节、密钥解密及拒绝覆盖已有目标。完成后删除它自己创建的临时库和文件。

外部模型真实扣费、EchoTik 套餐数据和 TikTok 审核后发布不在离线部署验收中；生产上线前使用自己的服务凭证进行受控验证。
