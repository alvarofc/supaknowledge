-- Follow-ups from the bot reviews of PR #5.
--
-- private.valid_concept_path (proposal ops, create_proposal's op validation) gets the segment rule that
-- 20261125000024 gave concepts.path: no empty or "." segment ("a//b", "a/./b", "./a", trailing "/"). Before
-- this, an op such as metrics//arr passed proposal validation and only failed inside apply_proposal.
-- The proposal_ops check constraints call this function; existing rows are not re-validated (a pending op with
-- such a path could never have been applied anyway).

create or replace function private.valid_concept_path(p text) returns boolean
language sql immutable as $$
  select p is not null
    and p ~ '^[A-Za-z0-9_][A-Za-z0-9_./-]*$'
    and p !~ '\.\.'
    and p !~ '\.md$'
    and p !~ '(^|/)\.?(/|$)'
    and length(p) <= 512;
$$;
