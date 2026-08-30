export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`);
  }
  return value;
}

export function normalizeName(value: string): string {
  const normalized = stringValue(value, 'Name')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) {
    throw new ValidationError('Name must not be empty');
  }
  return normalized;
}

export function normalizeOpenLibraryWorkId(value: string): string {
  const candidate = stringValue(value, 'Open Library work ID').trim();
  const match = /^(?:\/works\/)?(OL[0-9]+W)$/i.exec(candidate);
  if (!match) {
    throw new ValidationError('Invalid Open Library work ID');
  }
  return match[1].toUpperCase();
}

function isbnError(): never {
  throw new ValidationError('Invalid ISBN');
}

export function normalizeIsbn(value: string): string {
  const compact = stringValue(value, 'ISBN')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\p{P}\p{White_Space}]/gu, '');

  if (/^[0-9]{9}[0-9X]$/.test(compact)) {
    let sum = 0;
    for (let index = 0; index < compact.length; index += 1) {
      const digit = compact[index] === 'X' ? 10 : Number(compact[index]);
      sum += digit * (10 - index);
    }
    if (sum % 11 === 0) {
      return compact;
    }
    return isbnError();
  }

  if (/^[0-9]{13}$/.test(compact)) {
    let sum = 0;
    for (let index = 0; index < compact.length; index += 1) {
      sum += Number(compact[index]) * (index % 2 === 0 ? 1 : 3);
    }
    if (sum % 10 === 0) {
      return compact;
    }
  }

  return isbnError();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeCitationUrl(value: string): string {
  const input = stringValue(value, 'Citation URL');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ValidationError('Invalid citation URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Citation URL must use HTTP(S)');
  }

  url.hash = '';
  url.searchParams.sort();
  const sortedPairs = [...url.searchParams.entries()].sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      compareStrings(leftName, rightName) || compareStrings(leftValue, rightValue),
  );
  url.search = new URLSearchParams(sortedPairs).toString();
  return url.toString();
}

export const READING_STATUSES = [
  'recommended',
  'interested',
  'reading',
  'read',
  'abandoned',
  'not_interested',
] as const;

export type ReadingStatus = (typeof READING_STATUSES)[number];
