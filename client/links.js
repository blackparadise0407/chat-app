// Parse before HTML escaping so query parameters containing & remain intact.
export function extractLinks(text) {
  const links = [];
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let value = match[0].replace(/[.,;!]+$/, '');
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length)
        value = value.slice(0, -1);
    }
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        value.length > 2048
      )
        continue;
      links.push({
        url: url.href,
        text: value,
        start: match.index,
        end: match.index + value.length,
      });
    } catch {}
  }
  return links;
}
