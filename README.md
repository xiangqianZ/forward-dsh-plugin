# DSH 实用插件集合

一些用于 DeepSeek Harness（DSH）的实用插件。每个子目录都是一个可独立安装的 DSH bundle，适用于 DSH `>= 0.2.2-rc.3`。

## 插件

| 插件 | 作用 | 使用入口 |
|---|---|---|
| [`forward-workspace-model`](forward-workspace-model/) | 给工作区绑定模型；该目录下新建会话自动使用绑定模型，会话内切换模型不受影响。 | 侧边栏工作区右键菜单 / `…` 菜单，菜单项显示当前模型名，点击切换 |
| [`forward-git-commit`](forward-git-commit/) | 在会话标题栏一键提交并推送当前 Git 工作区。 | 会话标题栏右侧「提交」按钮 |
| [`forward-process-manager`](forward-process-manager/) | 查看并结束当前项目里占用端口的进程。 | 会话标题栏「提交」按钮旁的「进程」按钮 |

每个插件目录里的 `README.md` 有更详细的用法说明。

## 安装

在本仓库根目录执行：

```sh
# 工作区模型
dsh plugin --profile desktop add ./forward-workspace-model

# 一键提交并推送
dsh plugin --profile desktop add ./forward-git-commit

# 项目进程管理
dsh plugin --profile desktop add ./forward-process-manager
```

也可以打开 DSH 的 **插件 → 安装插件**，选择对应子目录。

安装后如果界面没有更新，完全退出 DSH 再启动。

## 卸载

```sh
dsh plugin --profile desktop remove <包名>
```

例如：

```sh
dsh plugin --profile desktop remove @forward/workspace-model
```
