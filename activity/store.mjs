// The activity's saved data, in one SQLite file (Node's built-in node:sqlite,
// so the server needs no npm packages):
//
//   players       one row per Discord user: name, avatar and their stats, in
//                 the same shape web/daily.js keeps in localStorage
//   room_players  who has played in which Discord server (or DM / group DM),
//                 for the "Today in this server" list
import { DatabaseSync } from 'node:sqlite';

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS players (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      stats      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_players (
      room      TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES players(id),
      PRIMARY KEY (room, player_id)
    );
  `);

  const getPlayer = db.prepare('SELECT id, name, avatar_url, stats FROM players WHERE id = ?');
  const putPlayer = db.prepare(`
    INSERT INTO players (id, name, avatar_url, stats, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url,
      stats = excluded.stats, updated_at = excluded.updated_at
  `);
  const joinRoom = db.prepare('INSERT OR IGNORE INTO room_players (room, player_id) VALUES (?, ?)');
  const roomPlayers = db.prepare(`
    SELECT p.id, p.name, p.avatar_url, p.stats FROM room_players r JOIN players p ON p.id = r.player_id
    WHERE r.room = ? ORDER BY p.updated_at DESC LIMIT 200
  `);

  const toPlayer = (row) => row && {
    id: row.id, name: row.name, avatarUrl: row.avatar_url, stats: JSON.parse(row.stats),
  };

  return {
    // { id, name, avatarUrl, stats } or null
    getPlayer: (id) => toPlayer(getPlayer.get(id)),
    savePlayer({ id, name, avatarUrl, stats }) {
      putPlayer.run(id, name, avatarUrl, JSON.stringify(stats), Date.now());
    },
    joinRoom: (room, playerId) => { joinRoom.run(room, playerId); },
    roomPlayers: (room) => roomPlayers.all(room).map(toPlayer),
    close: () => db.close(),
  };
}
