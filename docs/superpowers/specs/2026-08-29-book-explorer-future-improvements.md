# Book Explorer Future Improvements

**Status:** Backlog — not approved for implementation

This document records ideas deliberately excluded from the version 1 MVP. Each item requires evidence from actual use before design or implementation.

## Structured Book Facets

Add a controlled but extensible vocabulary only if free-text book notes and taste notes become difficult to search or apply consistently.

Possible initial facets:

- `pace`: `measured`, `frenetic`
- `scope`: `intimate`, `institutional`, `epic`
- `character`: `shallow`, `developing`, `long_arc`
- `tone`: `escapist`, `emotionally_heavy`, `grim`, `humorous`
- `competence`: `low`, `moderate`, `central`
- `speculation`: `realistic`, `consistent_black_box`, `pseudo_realistic`
- `action`: `clear`, `chaotic`, `spectacle_driven`
- `politics`: `background`, `observational`, `didactic`
- `structure`: `standalone`, `episodic_series`, `continuous_series`

Book characteristics and user preferences must remain separate: a book may be `grim` without implying the user dislikes grim books in every context. Assistant-proposed classifications, values, facets, and preference observations would require approval. New vocabulary proposals should explain why an existing term is insufficient, preventing accidental synonyms such as `slow`, `patient`, and `measured`.

**Add when:** repeated free-text descriptions become inconsistent enough to impair filtering or recommendations.

## Goodreads and StoryGraph Import

Evaluate actual export files before choosing either integration. Determine whether they provide work identifiers, ISBNs, series, reading status, ratings, dates, reviews, and stable mappings to Open Library works.

**Add when:** manual entry becomes the main barrier to using the tool.

## Semantic Retrieval and Recommendation Graph

Potential later steps, in increasing order of complexity:

1. SQLite full-text search over notes and recommendation rationales.
2. Structured facets.
3. Per-facet embeddings rather than one embedding per book.
4. An explainable graph whose edges state why two books are related.
5. Learned ranking from approved contrasts and rejected recommendations.

**Add when:** the agent cannot retrieve relevant history accurately from the existing library tools.

## Availability and Ownership

Potentially track editions and formats to support Kindle Unlimited, Libby, Hoopla, owned copies, and audiobooks. This would require promoting ISBNs from work-level lookup aliases into edition records and handling library-specific availability.

**Add when:** recommendation discovery works, but finding an obtainable format is repeatedly cumbersome.

## Backup and Provider Options

- S3 backup or synchronization for the SQLite database and Pi JSONL conversation sessions.
- AWS Bedrock through its OpenAI-compatible Responses API for centralized billing.
- Direct OpenAI API billing if subscription-backed Pi access proves unreliable.

**Add when:** local-only recovery or Codex subscription limits cause a demonstrated problem.

## Visualization

A traversable recommendation graph could show preserved and changed characteristics across genre boundaries—for example, moving from *Frontlines* to *The Praxis* through measured pacing and institutional scale.

**Add when:** a visual graph answers discovery questions that conversation and filtered lists do not.
