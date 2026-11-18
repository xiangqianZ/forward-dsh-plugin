# 提交并推送（forward-git-commit）

会话标题栏右侧的一个按钮：点开弹窗显示当前分支、改动数量与远端，输入提交信息后
一次完成 `git add -A` → `git commit` → `git push`。

## 安装

在本仓库根目录执行（或在 **插件 → 安装插件** 里选择 `forward-git-commit` 目录）：

```sh
dsh plugin --profile desktop add ./forward-git-commit
```

## 位置

会话标题栏那一行的右侧，与「后台任务」等控件同排，就在「对话 / 上下文 / 编队」标签行上方。
切换会话时弹窗自动关闭。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：`git status` / `git add -A` / `commit` / `push`，经 `ctx.subprocess` 执行 |
| `client.js` | 浏览器半：标题栏按钮 + 弹窗，手写 lazy-CJS，只 require `react` / `react-dom` |
| `cordis.patch.yml` | 组合包：插入一行 `git-commit` |
| `locale/{zh,en}.json` | 插件页标题与描述 |
| `docs/DETAIL.md` | 插件详情页正文 |
| `test/e2e.mjs` | Host 半对真实 git 仓库的端到端测试（27 项） |
| `test/client.test.mjs` | 浏览器半的结构测试（工厂、槽位、词条、首帧） |

## 测试

```sh
node test/e2e.mjs         # 建临时仓库 + 裸远端，跑通提交与推送，含拒绝路径
node test/client.test.mjs # 无 React 环境下的结构校验
```

## 设计取舍

- **暂存范围是整个工作区**：按钮承诺「把现在的改动提交上去」，弹窗上的文件数就是这个范围。
- **不做破坏性操作**：没有 `push --force`、`reset --hard`、`clean`、`checkout --`。推送被拒就报错。
- **推送失败时提交已落地**：错误信息写明提交哈希，修好后再推一次即可，不会产生第二个提交。
- **提交信息走 stdin**（`git commit -F -`）：引号、换行、以 `-` 开头的内容都按文本处理。
- **子进程**：`GIT_TERMINAL_PROMPT=0`（缺凭据立即失败而不是挂住）、`GIT_OPTIONAL_LOCKS=0`、
  `LC_ALL=C`；环境里 `*TOKEN*` / `*SECRET*` 形状的变量由 subprocess 服务清除。
- **路由挂在 `connection.fetch`**，不是 `webServer`：`/api` 前缀路由才是 Host/Origin 校验与
  浏览器 cookie 检查所在处，绕过它等于开一个未鉴权的 git 接口。
