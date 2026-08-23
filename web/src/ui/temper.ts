export type TemperState = "COLD" | "SECURE" | "WATCH" | "ARMED" | "BURN" | "VOID";

export const TEMPER: Record<TemperState, { hex: string; label: string }> = {
  COLD: { hex: "#8A939B", label: "COLD" },
  SECURE: { hex: "#7FA8C9", label: "SECURE" },
  WATCH: { hex: "#E8C170", label: "WATCH" },
  ARMED: { hex: "#C77B3C", label: "ARMED" },
  BURN: { hex: "#FF6B1A", label: "BURN" },
  VOID: { hex: "#0A0B0C", label: "VOID" },
};
