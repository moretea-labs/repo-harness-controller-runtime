export const ADOPTION_MODES = ["minimal", "standard", "self-host"] as const;

export type AdoptionMode = (typeof ADOPTION_MODES)[number];

export function isAdoptionMode(value: string): value is AdoptionMode {
  return (ADOPTION_MODES as readonly string[]).includes(value);
}
