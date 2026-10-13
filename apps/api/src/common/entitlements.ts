/** Maps the first URL path segment to a licensable feature. Unlisted segments belong to the always-on core. */
export const FEATURE_BY_SEGMENT: Record<string, string> = {
  transport: 'transport', library: 'library', inventory: 'inventory', procurement: 'inventory', assets: 'inventory',
  hr: 'hr_payroll', payroll: 'hr_payroll', meals: 'meals', activities: 'activities', awards: 'activities',
  health: 'health', counselling: 'health', security: 'security',
};
export const OPTIONAL_FEATURES = [...new Set(Object.values(FEATURE_BY_SEGMENT))];
/** Plans decide the default set; per-tenant `features` overrides (true/false) win. */
export const PLAN_DEFAULTS: Record<string, string[]> = { basic: [], standard: OPTIONAL_FEATURES, premium: OPTIONAL_FEATURES };

export function featureEnabled(plan: string, overrides: Record<string, boolean> | null, feature: string): boolean {
  if (overrides && feature in overrides) return overrides[feature] === true;
  return (PLAN_DEFAULTS[plan] ?? []).includes(feature);
}
