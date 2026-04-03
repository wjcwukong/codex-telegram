export function renderSections(
  sections: Array<{ title: string; lines: Array<string | undefined> }>,
): string {
  return sections
    .map((section) => {
      const lines = section.lines.filter((line): line is string => Boolean(line))
      if (lines.length === 0) {
        return undefined
      }

      return [`[${section.title}]`, ...lines].join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}
