# Chrome Web Store 发布材料

当前商店文案、八项必需权限（含 downloads）用途、数据与执行功能说明和审核材料统一维护于 [商店材料草稿](store-listing.md)。当前实现与最近一次完整测试证据见 [需求对齐验收](alignment-acceptance.md)；0.3.0 候选包的结果保留在[历史正式化验收记录](formalization-acceptance.md)。

版本以 package.json 为唯一来源，构建时写入 Manifest。当前仅保留本地 ZIP 与 SHA-256 打包能力，不配置自动发布，也尚未提交 1.0.0 商店审核。

## 1.0.0 提交前核对

- 用本次候选 ZIP 更新详细说明、权限用途与隐私申报；删除线上 0.2.0 文案中的 Jev 服务。
- 在审核备注中明确：`run` 执行模型响应产生的 JavaScript，计算位于 opaque-origin sandbox Worker，浏览器操作通过 Side Panel 的显式能力 RPC 完成；同时披露跨窗口标签页、任意 CDP、网络和持久用户脚本能力。
- 上传与 1.0.0 候选一致的 Side Panel、下载确认和设置页截图，不复用迁移前素材。
- 人工验证远程 HTTP 警告、隐身模式持久日志提示、每次产物下载确认、拒绝下载、永久清空后 IndexedDB 只剩新的 `log.cleared` 事件。
- 确认公开隐私政策生效日期、GPL-3.0-only 源码链接、支持链接和开发者联系信息。
- 商店提交和实际发布必须在候选 ZIP 的 SHA-256 与 `release-notes.md` 中提交哈希一致后由维护者手动确认。
