# Kie.ai 视频渠道

在「连接与设置 → Kie.ai」填写 API Key 并保存，或在服务器设置 `KIE_API_KEY`。凭证按工作空间隔离，随现有设置使用 AES-256-GCM 加密保存于 MySQL；读取接口只返回是否配置。留空保留原值，勾选清除后保存才删除。不要把真实 Key 提交到 Git。

在创作工作台、创建项目或确认分镜时，选择「视频生成渠道 → Kie.ai」，再选型号与分辨率。设置页可以更改默认视频模型；默认仍保留现有 Kling/fal 选择。未修改的旧版双 Kling 目录自动兼容增加 Kie；自定义目录不自动覆盖，需按下表自行加入条目。每个任务固定自己的渠道、端点、型号、时长、分辨率与首帧方式，修改设置不改写已排队任务。

| ID                  | API model                                 | 适配器              | 时长      | 分辨率     | 画幅            |
| ------------------- | ----------------------------------------- | ------------------- | --------- | ---------- | --------------- |
| `kie-veo-fast`      | `veo-3-1`，另指定 `input.model=veo3_fast` | `kie-veo-fast`      | 4/6/8 秒  | 720p/1080p | 9:16、16:9      |
| `kie-seedance-mini` | `bytedance/seedance-2-mini`               | `kie-seedance-mini` | 4–15 整秒 | 480p/720p  | 9:16、16:9、1:1 |

高级目录的每个 Kie 条目必须设置 `provider: "kie"`，端点与适配器须匹配。fal 旧条目未指定 provider 时继续默认 fal。当前 Kie 适配器未实现独立角色元素；需要该功能时选择原有 Kling 模型。

## 首帧与分镜

- **直接使用第一张商品图**：Kie 默认。把本地商品图通过官方 multipart 上传接口传到 Kie，再按分镜提示逐段生成。不会要求 fal Key，也不额外生成每段 AI 首帧。界面明确只使用第一张图；它会成为每段开头，因此画面连续性需要检查。
- **AI 场景首帧（fal.ai）**：保留现有每段先生成场景首帧的流程，再把首帧交给 Kie 生成视频。需要额外配置 fal Key，首帧单独计费。
- Gemini 仍负责自动分析和分镜；已有确认分镜的任务不要求再次配置 Gemini。短片生成、保存片段、FFmpeg 裁切统一画幅/帧率/音轨与拼接均复用现有流程。
- Veo 使用 `FIRST_AND_LAST_FRAMES_2_VIDEO` 配一张首帧，明确关闭模型 fallback，固定 Fast 档。其原生音频默认开启，不把不受支持的静音选项转成假成功。Mini 使用 `first_frame_url` 与 `generate_audio`，不把参考视频加入请求产生额外计费时长。

供应商上传的临时文件保留 24 小时；直接商品图在提交前若上传时间已超过 20 小时会重新上传。生成结果按现有受控下载流程立即存入本地/配置的对象存储，之后从自己的素材库读取。

## 请求和故障恢复

提交：`POST https://api.kie.ai/api/v1/jobs/createTask`，使用 Bearer Key，任务 ID 持久化到 MySQL。查询：`GET /api/v1/jobs/recordInfo?taskId=...`，只轮询已有任务；本版不对外开放新的回调入口。

`waiting`/`queuing`/`generating` 持续查询，`success` 读取结果，`fail` 为明确失败。Mini 读取 `resultJson.resultUrls`；Veo 同时支持文档中的 `resultJson.data.result_urls`，不会用 `origin_urls` 代替选定的高分辨率成片。

不自动重试可能付费的提交。提交超时、服务端错误、成功响应缺少任务 ID、重启发生在提交阶段等情况进入待核对；没有 ID 不重发。查询出错保留原 ID，恢复后继续原任务。明确失败允许复用首帧与成功片段重试；只重拼的任务不需要生成凭证。

未找到 Kie 官方任务取消 API，因此取消会停止尚未提交的片段，已提交任务继续查询并核对结果；它仍可能计费。不用不存在的取消接口承诺退款或无费用。

「模型与高级生成」仍展示各型号，但原始 JSON 提交入口只面向现有 fal 渠道；Kie 使用工作台/项目中的已验证参数入口。

## 验证范围与官方资料

单元测试验证提交字段、状态与嵌套结果、密钥不泄露、无隐式重发、渠道/能力校验和恢复。`npm run test:video` 使用真实 MySQL、真实 FFmpeg 与离线注入的 Kie HTTP 响应，验证两种型号从持久化到拼接、480p 输出、无 fal/Gemini 凭证运行确认分镜、密钥保留/清除及公开设置脱敏。未配置真实 Kie Key，未做付费生成；真实账号可用性、质量、耗时和账单尚待验证。

2026-10-19 核对的一手接口资料：

- [Veo 3.1 创建任务](https://docs.kie.ai/veo3-api/generate-veo-3-video)
- [Seedance Mini 创建任务](https://docs.kie.ai/market/bytedance/seedance-2-mini)
- [查询任务](https://docs.kie.ai/market/common/get-task-detail)
- [文件上传](https://docs.kie.ai/file-upload-api/quickstart)

接口公开 schema 有变动可能；本实现使用当前 `createTask` 契约，而非旧版 Veo 专用提交/查询接口。
