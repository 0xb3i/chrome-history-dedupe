const HAN_KEYWORD_PATTERN = /^\p{Script=Han}{3,}$/u;
const MAX_HAN_SUBSEQUENCE_SKIPS = 4;
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}+/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Ranges refer to the original string's UTF-16 offsets, as used by DOM text.
// A compatibility character can expand, or several code points can compose;
// each normalized character therefore retains its complete source grapheme.
function getSourceOffsets(text) {
  let decomposed = '';
  const sourceOffsets = [];
  for (const { segment, index } of GRAPHEMES.segment(text)) {
    const normalized = segment.normalize('NFKD');
    decomposed += normalized;
    for (let unit = 0; unit < normalized.length; unit += 1) sourceOffsets.push([index, index + segment.length]);
  }
  const offsets = [];
  let pendingSpace;
  // Segment after compatibility decomposition so forms such as Hangul ㄱ + ㅏ
  // compose as one source span, even when they were separate input graphemes.
  for (const { segment, index } of GRAPHEMES.segment(decomposed)) {
    const range = [sourceOffsets[index][0], sourceOffsets[index + segment.length - 1][1]];
    for (const character of segment.normalize('NFC').replace(/\p{Cf}+/gu, '')) {
      if (/\s/u.test(character)) {
        if (offsets.length) pendingSpace = pendingSpace ? [pendingSpace[0], range[1]] : range;
        continue;
      }
      if (pendingSpace) {
        offsets.push(pendingSpace);
        pendingSpace = undefined;
      }
      for (let unit = 0; unit < character.toLowerCase().length; unit += 1) offsets.push(range);
    }
  }
  return offsets;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function matchKeyword(value, keyword) {
  const ranges = [];
  for (let start = value.indexOf(keyword); start >= 0; start = value.indexOf(keyword, start + keyword.length)) {
    ranges.push([start, start + keyword.length]);
  }
  if (ranges.length) return { contiguous: true, ranges };
  if (!HAN_KEYWORD_PATTERN.test(keyword)) return null;

  const characters = [...value];
  const wanted = [...keyword];
  const offsets = [];
  let offset = 0;
  for (const character of characters) {
    offsets.push(offset);
    offset += character.length;
  }
  for (let start = 0; start < characters.length; start += 1) {
    if (characters[start] !== wanted[0]) continue;
    const matched = [[offsets[start], offsets[start] + characters[start].length]];
    let skipped = 0;
    for (let index = start + 1; index < characters.length && matched.length < wanted.length; index += 1) {
      if (characters[index] === wanted[matched.length]) matched.push([offsets[index], offsets[index] + characters[index].length]);
      else if (++skipped > MAX_HAN_SUBSEQUENCE_SKIPS) break;
    }
    if (matched.length === wanted.length) return { contiguous: false, ranges: matched };
  }
  return null;
}

function sourceRanges(text, matches) {
  if (!matches.some(Boolean)) return [];
  const offsets = getSourceOffsets(text);
  return mergeRanges(matches.filter(Boolean).flatMap(({ ranges }) => ranges.map(([start, end]) => (
    [offsets[start][0], offsets[end - 1][1]]
  ))));
}

export function createSearchQuery(query) {
  const text = normalizeSearchText(query);
  return { text, keywords: [...new Set(text.split(' ').filter(Boolean))] };
}

export function matchSearchTitles(title, titles, normalizedTitles, query) {
  const displayedTitle = String(title ?? '');
  const normalizedTitle = normalizeSearchText(displayedTitle);
  // URL-like fallback titles never become searchable, including the display title.
  const titleIsSearchable = normalizedTitles.includes(normalizedTitle);
  const titleMatches = query.keywords.map((keyword) => titleIsSearchable ? matchKeyword(normalizedTitle, keyword) : null);
  const missing = new Set(titleMatches.flatMap((match, index) => match ? [] : [index]));
  const aliases = [];
  let aliasScore = 0;
  for (let index = 0; index < titles.length; index += 1) {
    const normalized = normalizedTitles[index];
    if (normalized === normalizedTitle) continue;
    const matches = query.keywords.map((keyword) => matchKeyword(normalized, keyword));
    if (matches.every(Boolean)) {
      aliasScore = Math.max(aliasScore, normalized === query.text ? 200 : matches.every((match) => match.contiguous) ? 150 : 100);
    }
    const neededMatches = matches.map((match, keywordIndex) => missing.has(keywordIndex) ? match : null);
    if (neededMatches.some(Boolean)) {
      aliases.push({ text: titles[index], ranges: sourceRanges(titles[index], neededMatches) });
      neededMatches.forEach((match, keywordIndex) => { if (match) missing.delete(keywordIndex); });
    }
  }
  if (missing.size) return null;
  const score = titleMatches.every(Boolean)
    ? normalizedTitle === query.text ? 500 : titleMatches.every((match) => match.contiguous) ? 400 : 300
    : aliasScore || 100;
  return { score, titleRanges: sourceRanges(displayedTitle, titleMatches), aliases };
}
