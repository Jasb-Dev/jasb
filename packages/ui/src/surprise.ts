/**
 * "Surprise me": curious questions whose best answers live on real sites.
 * Picked to show the product at its best: a mix of reference, how-to, history
 * and small-web material, none of it a query an AI summary would do justice.
 */
export const SURPRISES = [
  "why do cats knead blankets",
  "how deep is the mariana trench compared to everest",
  "who invented the pencil eraser",
  "best free alternatives to photoshop",
  "how do tardigrades survive vacuum",
  "what happened to the library of alexandria",
  "how to fold a fitted sheet",
  "how does a mechanical watch keep time",
  "learn touch typing free",
  "why do onions make you cry",
  "how were the pyramids aligned to north",
  "indie games like stardew valley",
];

export function randomSurprise(): string {
  return SURPRISES[Math.floor(Math.random() * SURPRISES.length)]!;
}
