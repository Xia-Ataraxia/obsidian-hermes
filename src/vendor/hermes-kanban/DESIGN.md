# Native Kanban packaging contract

This library preserves the pinned Hermes 0.22.3 Kanban source, native Nous UI 0.18.2 controls and native CSS. It does not compose a new screen or redesign controls. The approved plan and captured 130-control inventory govern later host work.

The design tokens and all spacing, color, state and motion recipes remain in immutable upstream.css, upstream-host.css and the exact locked Nous UI globals.css. Build scoping maps document roots to `.hcv-kanban-root`, namespaces custom properties/animations and removes document view transitions. Native resets apply only within that view.

The required reusable primitives are Card, CardContent, Badge, Button, Input, Label, Select, SelectOption, Checkbox and ConfirmDialog. The exact native components are bundled, including their hover, focus, disabled, selection and dialog states. No generic component replacements are permitted.

Typography adaptation: font binaries have no verified embedding notices. Map Collapse, Rules and Mondwest to Obsidian's interface font, and Courier/JetBrains to its monospace font. This intentionally changes glyphs/metrics; preserve native size, weight, tracking and hierarchy. No remote asset requests. Color/layout fidelity still comes from native tokens, not invented replacements.

This task's surface is a library factory and generated CSS. Rendering, leaf-contained drawers, dialog portals, keyboard/pointer lifecycle and native screenshot comparisons require the later SDK/ItemView task. Nothing is mounted by this build change.

Task16 adds the mounted ItemView wrapper without replacing native controls. The wrapper is a vertical flex container with a quiet status row and a remaining-height native root; the root owns overflow. Host status/draft messages use Obsidian `--size-4-2`, `--font-ui-small`, `--text-muted`, `--text-normal`, and `--background-secondary`. No new color palette, animation or decorative edge is introduced. Status and conflict messages are text with status/alert roles; freshness includes connection, board and last successful read time. Dirty text remains mounted during remote refresh. Keyboard close veto and installed theme/size/focus fidelity are accepted pending task20 UI-BIND and task16's actual UI scenarios; headless component screenshots do not close that debt.
