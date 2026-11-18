# @forward/workspace-model

Bind a model to a registered DSH workspace.

## Install

From this repository root:

```sh
dsh plugin --profile desktop add ./forward-workspace-model
```

Or choose the `forward-workspace-model` directory in **Plugins → Add plugin**.

## Usage

Open a workspace's right-click menu or its `…` button in the sidebar. The menu item shows the model currently bound to that workspace (or the deployment default when nothing is bound). Selecting it opens a searchable model picker; the model catalog is the same one used by `/model`.

- **Save** binds the model to that workspace.
- **Clear binding** removes the workspace binding.

## Behavior

- A binding applies only to Sessions created **after** it is saved. Saving also updates any live blank Session in that workspace (one that has never made a model request).
- The plugin writes `model/selection` directly through `Agent.model`, so a new Session starts on the bound model without changing the deployment-wide default model.
- Switching models inside a Session still works. That switch belongs only to that Session and does **not** change the workspace binding.
- Bindings are stored in this plugin's configuration in the active profile, keyed by the workspace's canonical directory path. No workspace files are modified.

## Limitations

- Workspace rows expose a context-menu contribution, not a dedicated inline button slot; the control appears in the workspace's `…` menu and right-click menu.
- A binding applies to Sessions that have not made a model request yet. A blank Session that already existed before the binding was saved is corrected when it is opened again; Sessions that have already sent a request keep their own model.
- The first version binds provider and model only; reasoning effort follows the adapter default. Use the in-session model selector when you need a specific effort.
