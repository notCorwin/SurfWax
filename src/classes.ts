type ClassValue = string | false | null | undefined

export function classes(...values: ClassValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ")
}

export function stateClasses<State>(
  base: string,
  value?: string | ((state: State) => string | undefined),
): string | ((state: State) => string) {
  if (typeof value === "function") return (state) => classes(base, value(state))
  return classes(base, value)
}
