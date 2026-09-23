// Monaco's menu registry. The package ships no declarations for its internal
// modules, so this covers only what ui/contextmenu.ts touches.
declare module "monaco-editor/esm/vs/platform/actions/common/actions.js" {
  export interface MenuIdentity {
    readonly id: string;
  }
  export type MenuRegistryItem = { command: { id: string } } | { submenu: MenuIdentity };
  export const MenuId: { readonly EditorContext: MenuIdentity };
  export const MenuRegistry: {
    getMenuItems(id: MenuIdentity): MenuRegistryItem[];
  };
}
