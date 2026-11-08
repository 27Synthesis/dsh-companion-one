# 发布清单

仓库：<https://github.com/27Synthesis/dsh-companion-one>

## 1. 社交预览（Social preview）

1. 打开仓库 **Settings → Social preview → Edit**
2. 上传 `docs/cover.png`（1280×640）
3. 保存。之后把仓库链接发到聊天、Issue、社交平台，卡片就是这张封面

> GitHub 没有开放 Social preview 的写入 API，这一步只能手动传一次；`docs/cover.svg` 是源文件，改字后重新导出 PNG 即可。

## 2. 插件市场（awesome-dsh-plugin）

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. 新建 `data/plugins/27Synthesis__dsh-companion-one.yml`
3. 把 `MARKETPLACE.yml` 去掉开头注释后的正文粘进去（category 用 `memory`）
4. 开 PR，标题：`add 27Synthesis/dsh-companion-one`

PR 描述建议强调这句，市场上没人占这个位置：

> One plugin instead of five: memory, compression, persona, style learning, and companionship boundaries in a single self-contained SQLite-backed plugin for the dsh-go native phone UI — zero native builds, no traffic proxying, no extra model calls by default.

仓库 topic 已设置（`dsh-plugin` 在列），市场站点会自动扫描到。

## 3. 截图（可选，但很加分）

面板在 **设置 › 陪伴**，建议拍三张：

| 文件 | 画面 |
| --- | --- |
| `docs/screenshots/overview.png` | 概览页：心情、压力、最近一句心声 |
| `docs/screenshots/memory.png` | 记忆页：七层分组与搜索 |
| `docs/screenshots/compression.png` | 压缩页：压力条、块列表、还原按钮 |

拍完放进 `docs/screenshots/`，在 README 的「功能全景」前加一节 `## 📸 界面` 引用即可。

## 4. CI（可选）

本地保留了 `.github/workflows/test.yml`。上次发布用的 token 没有 **Workflows** 写权限，所以远端仓库暂时没有这个文件；要补 CI，给 token 勾上 Workflows 后重新 push，或在网页端手动新建。

## 5. 版本

`v0.1.0` 已打在首个提交上。下次功能更新建议：

```bash
git tag -a v0.1.1 -m "companion-one v0.1.1"
git push origin v0.1.1
```
