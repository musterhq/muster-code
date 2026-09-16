export const MUSTER_THEMES = [
  { name: "Muster Dark", description: "Sage · quiet green surfaces", colors: ["#121918", "#18201F", "#9BD7C4"] },
  { name: "Muster Graphite", description: "Neutral · charcoal and the reference IDE steel", colors: ["#141414", "#181818", "#81A1C1"] },
  { name: "Muster Midnight", description: "Cool · deep blue and periwinkle", colors: ["#111725", "#171E2E", "#B4C5FF"] },
  { name: "Muster Light", description: "Clear · paper and forest green", colors: ["#FFFFFF", "#F7F7F7", "#276B55"] },
  { name: "Muster Sand", description: "Warm · ivory and bronze", colors: ["#F4EFE5", "#FCF9F3", "#74552F"] },
] as const;
export const appearanceDefaults = { density: "comfortable", fontSize: 13, accent: "", glass: true };
