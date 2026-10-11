-- 0004 — agent names freed of Jenkins console notes.
--
-- A Pipeline run's agent is read from its log's "Running on <agent> in …"
-- line, and Jenkins writes a console note — ESC[8m ha:////<base64> ESC[0m,
-- the link on the agent's name — inside that line. Until the integration
-- stripped them (integrations/jenkins, stripNotes), the note was kept as part
-- of the name: "<note>devops08". Data only; new builds are read clean.
update jenkins_builds
   set built_on = nullif(btrim(regexp_replace(built_on, chr(27) || '\[8mha:[A-Za-z0-9+/=]*' || chr(27) || '\[0m', '', 'g')), '')
 where strpos(built_on, chr(27) || '[8mha:') > 0;
