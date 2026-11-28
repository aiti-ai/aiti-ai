/**
 * panel-bus —— QueuePanel 与控制器之间的命令总线。
 *
 * QueuePanel 挂载时把本实例的 expand/notice 能力登记进来（替换式，单实例）；
 * entry 注册的 QueuePanelController 调用时经它转发。避免 key 重挂丢内部状态。
 */

export interface PanelCommands {
  expand(): void;
  notice(text: string, ok: boolean): void;
}

let commands: PanelCommands | null = null;

/** QueuePanel 挂载时登记；卸载时传 null。 */
export function setPanelCommands(c: PanelCommands | null): void {
  commands = c;
}

export function getPanelCommands(): PanelCommands | null {
  return commands;
}
