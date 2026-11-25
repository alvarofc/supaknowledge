-- update_space_settings(): compare-and-swap saves of space settings (migration 20261125000026).
begin;
\ir _fixture.psql
select plan(6);

select tests.as_postgres();
update public.spaces set settings = '{"curator": {"enabled": true}}'::jsonb where id = tests.id('s1');

select tests.as_user('s_admin');
select is(public.update_space_settings(tests.id('s1'), '{"curator": {"enabled": false}}', '{"curator": {"enabled": true}}'),
  'saved', 'an admin saves when the stored settings still match what the form merged against');
select is((select settings from public.spaces where id = tests.id('s1')), '{"curator": {"enabled": false}}'::jsonb,
  'the new settings are stored');
select is(public.update_space_settings(tests.id('s1'), '{"curator": {"enabled": true}}', '{"curator": {"enabled": true}}'),
  'conflict', 'a save merged against stale settings reports a conflict');
select is((select settings from public.spaces where id = tests.id('s1')), '{"curator": {"enabled": false}}'::jsonb,
  'a conflicting save changes nothing');

select tests.as_user('s_editor');
select is(public.update_space_settings(tests.id('s1'), '{}', '{"curator": {"enabled": false}}'),
  'forbidden', 'an editor cannot change settings (RLS still applies)');

select tests.as_user('member_b');
select is(public.update_space_settings(tests.id('s1'), '{}', '{}'), 'not_found', 'a space you cannot see is not found');

select * from finish();
rollback;
