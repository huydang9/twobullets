/** A message that depends on `params.count`: CLDR plural categories, `other` required (Vietnamese only uses `other`). */
export interface PluralMessage {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Message = string | PluralMessage;

export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** "{name} killed {victim}" + params. Unknown placeholders are left as they are, so a missing param is visible. */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params || template.indexOf("{") < 0) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

const pluralRules = new Map<string, Intl.PluralRules>();

/** Picks the plural form for `count` in `locale` (falls back to `other`). */
export function selectPlural(message: PluralMessage, count: number, locale: string): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const category = rules.select(count) as keyof PluralMessage;
  return message[category] ?? message.other;
}

export type TemplatePart = { readonly text: string } | { readonly param: string };

/** Splits "{you} killed {victim}" into literal and placeholder parts, for templates that place DOM nodes. */
export function templateParts(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: template.slice(last, index) });
    parts.push({ param: match[1]! });
    last = index + match[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}
