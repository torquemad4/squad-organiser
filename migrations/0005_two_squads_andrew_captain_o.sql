-- Most squads a tournament can have (NULL = no limit). The World Cup has exactly two: X and O.
ALTER TABLE tournaments ADD COLUMN max_squads INTEGER;
UPDATE tournaments SET max_squads = 2 WHERE slug = 'world-cup-2027';

-- Andrew Dodd (Baron_Greenback, NAF 35454) captains squad O. Only runs if he has signed up and O doesn't exist yet.
DELETE FROM squad_members
 WHERE application_id IN (
   SELECT a.id FROM applications a JOIN users u ON u.id = a.user_id JOIN tournaments t ON t.id = a.tournament_id
    WHERE t.slug = 'world-cup-2027' AND u.naf_number = '35454')
   AND NOT EXISTS (SELECT 1 FROM squads s JOIN tournaments t ON t.id = s.tournament_id WHERE t.slug = 'world-cup-2027' AND s.position = 2);

INSERT INTO squads (tournament_id, captain_user_id, position)
SELECT t.id, u.id, 2
  FROM tournaments t JOIN applications a ON a.tournament_id = t.id AND a.status = 'active' JOIN users u ON u.id = a.user_id
 WHERE t.slug = 'world-cup-2027' AND u.naf_number = '35454'
   AND NOT EXISTS (SELECT 1 FROM squads s WHERE s.tournament_id = t.id AND s.position = 2)
 LIMIT 1;

INSERT INTO squad_members (application_id, squad_id)
SELECT a.id, s.id
  FROM squads s JOIN tournaments t ON t.id = s.tournament_id
  JOIN applications a ON a.tournament_id = t.id AND a.user_id = s.captain_user_id
 WHERE t.slug = 'world-cup-2027' AND s.position = 2
ON CONFLICT (application_id) DO NOTHING;
