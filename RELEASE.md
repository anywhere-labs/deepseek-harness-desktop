# 发布检查清单(release checklist)

社区重构三件套(去 vendor、Version Manager、contracts gate)合并后的发布路径,
按"维护者手里有签名凭据、社区能准备到哪一步"拆分。

## 社区侧可完成的(本仓库已做/可做)

- [x] Linux 全链路验证:typecheck / 单测 / stage-runtime / Host 启动自检 / electron-builder --dir
- [x] Upstream contract 门禁(快照 + CI diff,上游变化 CI 先爆)
- [x] validated-runtimes 矩阵机制("latest tested" 而非 "latest")
- [ ] Windows/macOS CI 平台矩阵(需上游仓库开启;electron 下载配 ELECTRON_MIRROR 镜像)
- [ ] THIRD_PARTY_NOTICES 重新生成(依赖清单 = @deepseek-ai/dsh + dsh-web-frontend 的 closure)

## 维护者侧必须做的(凭据/权限在维护者手里)

- [ ] 代码签名与公证(Windows 证书 / Apple Developer ID + notarytool)
- [ ] 自动更新通道(update 端点、签名元数据)
- [ ] 正式版号策略:重构后建议与上游对齐(当前上游 0.1.0-rc.6),桌面壳版本独立小步走
- [ ] 合并顺序:PR #60(去 vendor)→ PR #73(Version Manager,基于 #60 分支)→ contracts/CI 随 #73 合入

## 发布前冒烟(维护者本地)

```bash
pnpm install
pnpm run typecheck
pnpm --filter @deepseek-ai/dsh-desktop exec vitest run
node --import tsx scripts/verify-upstream-contract.ts
pnpm --filter @deepseek-ai/dsh-desktop run package   # 产出本平台 unpacked
```

## 升级上游的固定流程(已写入 AGENTS.md 与 CI)

1. 改 `apps/desktop/runtime/package.json` 两个 pin
2. `pnpm install` → `verify-upstream-contract` 先爆(审查 diff)
3. `--snapshot` 重新生成快照 → stage-runtime → Host 启动自检 → 单测
4. 全过后把新版本写进 `validated-runtimes.json`,发壳版本
