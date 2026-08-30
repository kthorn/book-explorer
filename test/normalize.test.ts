import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCitationUrl,
  normalizeIsbn,
  normalizeName,
  normalizeOpenLibraryWorkId,
  ValidationError,
} from '../src/normalize.js';

test('normalizes names with NFKC, lowercase, and collapsed Unicode whitespace', () => {
  assert.equal(normalizeName('  Ｆoo\u00a0  BAR\n\u2003baz  '), 'foo bar baz');
});

test('normalizes Open Library work IDs from accepted forms', () => {
  assert.equal(normalizeOpenLibraryWorkId('OL123W'), 'OL123W');
  assert.equal(normalizeOpenLibraryWorkId('/works/ol123w'), 'OL123W');
  assert.equal(normalizeOpenLibraryWorkId(' /WoRkS/Ol987w '), 'OL987W');
});

test('rejects malformed Open Library work IDs', () => {
  assert.throws(() => normalizeOpenLibraryWorkId('OL123'), ValidationError);
  assert.throws(() => normalizeOpenLibraryWorkId('/works/OL123W/extra'), ValidationError);
  assert.throws(() => normalizeOpenLibraryWorkId('https://openlibrary.org/works/OL123W'), ValidationError);
});

test('normalizes valid ISBN-10 and ISBN-13 values', () => {
  assert.equal(normalizeIsbn('0-306-40615-2'), '0306406152');
  assert.equal(normalizeIsbn('0 8044 2957 X'), '080442957X');
  assert.equal(normalizeIsbn('978-0-306-40615-7'), '9780306406157');
});

test('rejects ISBNs with invalid shapes or checksums', () => {
  assert.throws(() => normalizeIsbn('0-306-40615-3'), ValidationError);
  assert.throws(() => normalizeIsbn('978-0-306-40615-8'), ValidationError);
  assert.throws(() => normalizeIsbn('030640615X'), ValidationError);
  assert.throws(() => normalizeIsbn('not-an-isbn'), ValidationError);
});

test('normalizes citation URLs with canonical host, port, fragment, and query order', () => {
  assert.equal(
    normalizeCitationUrl('HTTPS://Example.COM:443/a/?z=2&a=1#fragment'),
    'https://example.com/a/?a=1&z=2',
  );
  assert.equal(
    normalizeCitationUrl('HTTP://Example.COM:80/path/?b=2&b=1&a=hello%20world#fragment'),
    'http://example.com/path/?a=hello+world&b=1&b=2',
  );
});

test('rejects non-HTTP(S) and malformed citation URLs', () => {
  assert.throws(() => normalizeCitationUrl('javascript:alert(1)'), ValidationError);
  assert.throws(() => normalizeCitationUrl('file:///tmp/book'), ValidationError);
  assert.throws(() => normalizeCitationUrl('/relative/path'), ValidationError);
  assert.throws(() => normalizeCitationUrl('not a URL'), ValidationError);
});
