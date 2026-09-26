# DSH Session 兼容补丁

[English](README.md) | 简体中文

DSH `0.1.7-rc.2` 的持久化读取器接受 `ignorable: true` 的外部插件事件，但 `Session.append()` 没有暴露写入该标记的参数。上下文插件需要记录失败计数、文件清单以及多次摘要调用，否则会话恢复后会丢失这些状态。

这里的补丁只允许非消息事件调用 `append(type, data, { ignorable: true })`，并把标记写入事件信封。它不修改会话格式版本、已有事件或压缩算法。插件的模型可见变化仍使用标准 DSH 消息与 compaction 事件。

## 本仓库

`pnpm-workspace.yaml` 已声明 `patchedDependencies`，执行 `pnpm install` 自动应用发布包补丁。测试调用 DSH 的 `validateStoredEvents()` 检查这些记录可以恢复。

## 实际 DSH 宿主

**补丁必须应用到创建实际会话的 DSH 运行时。** 仅在本库的开发依赖上应用补丁，不能代替宿主补丁。插件对其导入的 Session 类和实际会话的实现分别做隔离探测；探测不会写入用户会话。

如果 DSH 由 pnpm 项目安装，在该宿主项目中复制本目录的 `@deepseek-ai__dsh-session@0.1.7-rc.2.patch`，并合并以下配置到它的 `pnpm-workspace.yaml`，随后执行 `pnpm install`：

```yaml
patchedDependencies:
  '@deepseek-ai/dsh-session@0.1.7-rc.2': patches/@deepseek-ai__dsh-session@0.1.7-rc.2.patch
```

如果从 DSH 源码工作区启动，发布包补丁不会改变 workspace source。可在 DSH 仓库根目录检查并应用本目录的 `dsh-session-source.patch`，再按 DSH 的开发说明重建。补丁对应本库固定版本的源码位置；先用 `git apply --check <absolute-patch-path>` 确认当前 checkout 可以应用。

本仓库不会自动修改用户的 DSH 安装或 profile。宿主缺少补丁时，插件拒绝执行需要持久记录的流程并报告原因。DSH 将来公开支持这个参数后，可以删除这份补丁并更新固定依赖版本。

补丁包含 DSH 的少量上下文代码，使用 [MIT 许可证](DSH-LICENSE)。
