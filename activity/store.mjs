// The activity's saved data, in one SQLite file (Node's built-in node:sqlite,
// so the server needs no npm packages):
//
//   players       one row per Discord user: name, avatar and their stats, in
//                 the same shape web/daily.js keeps in localStorage
//   room_players  who has played in which Discord server (or DM / group DM),
//                 for the "Today in this server" list
//   results       each player's daily result: won, Pokémon left, RED's left, turns
//   cards         the bot's live card for each server and day (bot.mjs)
//   recaps        which morning recaps (date) and monthly announcements
//                 ('month:YYYY-MM') have been posted
//   settings      small things the server remembers (key/value)
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
    CREATE TABLE IF NOT EXISTS results (
      player_id   TEXT NOT NULL,
      date        TEXT NOT NULL,
      won         INTEGER NOT NULL,
      mons_left   INTEGER,
      red_left    INTEGER,
      turns       INTEGER,
      finished_at INTEGER NOT NULL,
      PRIMARY KEY (player_id, date)
    );
    CREATE INDEX IF NOT EXISTS results_by_date ON results (date);
    CREATE TABLE IF NOT EXISTS cards (
      guild_id   TEXT NOT NULL,
      date       TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, date)
    );
    CREATE TABLE IF NOT EXISTS recaps (
      guild_id  TEXT NOT NULL,
      date      TEXT NOT NULL,
      posted_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, date)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
  const putResult = db.prepare(`
    INSERT OR IGNORE INTO results (player_id, date, won, mons_left, red_left, turns, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const roomResults = db.prepare(`
    SELECT r.player_id, r.won, r.mons_left, r.red_left, r.turns FROM results r
    JOIN room_players rp ON rp.player_id = r.player_id WHERE rp.room = ? AND r.date = ?
  `);
  const roomDates = db.prepare(`
    SELECT DISTINCT r.date FROM results r JOIN room_players rp ON rp.player_id = r.player_id
    WHERE rp.room = ? AND r.date <= ? ORDER BY r.date DESC LIMIT 1000
  `);
  const recentPlayers = db.prepare(`
    SELECT DISTINCT r.player_id FROM results r JOIN room_players rp ON rp.player_id = r.player_id
    WHERE rp.room = ? AND r.date >= ? AND r.date < ?
  `);
  const roomsWithResults = db.prepare(`
    SELECT DISTINCT rp.room FROM results r JOIN room_players rp ON rp.player_id = r.player_id
    WHERE r.date = ? AND rp.room LIKE 'g:%'
  `);
  // A month's totals per player in a room (dates 'YYYY-MM-01' to 'YYYY-MM-31').
  const monthTotals = db.prepare(`
    SELECT r.player_id, SUM(r.won) AS wins, SUM(1 - r.won) AS losses,
      SUM(CASE WHEN r.won = 1 THEN COALESCE(r.mons_left, 0) ELSE 0 END) AS mons_left,
      SUM(COALESCE(r.turns, 0)) AS turns, COUNT(*) AS played
    FROM results r JOIN room_players rp ON rp.player_id = r.player_id
    WHERE rp.room = ? AND r.date >= ? AND r.date <= ? GROUP BY r.player_id
  `);
  const roomsInMonth = db.prepare(`
    SELECT DISTINCT rp.room FROM results r JOIN room_players rp ON rp.player_id = r.player_id
    WHERE r.date >= ? AND r.date <= ? AND rp.room LIKE 'g:%'
  `);
  const getCard = db.prepare('SELECT channel_id, message_id FROM cards WHERE guild_id = ? AND date = ?');
  const putCard = db.prepare(`
    INSERT INTO cards (guild_id, date, channel_id, message_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (guild_id, date) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
  `);
  const getRecap = db.prepare('SELECT 1 FROM recaps WHERE guild_id = ? AND date = ?');
  const putRecap = db.prepare('INSERT OR IGNORE INTO recaps (guild_id, date, posted_at) VALUES (?, ?, ?)');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

  const toPlayer = (row) => row && {
    id: row.id, name: row.name, avatarUrl: row.avatar_url, stats: JSON.parse(row.stats),
  };
  const toResult = (row) => ({
    won: Boolean(row.won), monsLeft: row.mons_left, redLeft: row.red_left, turns: row.turns,
  });

  return {
    // { id, name, avatarUrl, stats } or null
    getPlayer: (id) => toPlayer(getPlayer.get(id)),
    savePlayer({ id, name, avatarUrl, stats }) {
      putPlayer.run(id, name, avatarUrl, JSON.stringify(stats), Date.now());
    },
    joinRoom: (room, playerId) => { joinRoom.run(room, playerId); },
    roomPlayers: (room) => roomPlayers.all(room).map(toPlayer),

    // The first result saved for a player and day stays (like their stats).
    saveResult({ playerId, date, won, monsLeft = null, redLeft = null, turns = null }) {
      putResult.run(playerId, date, won ? 1 : 0, monsLeft, redLeft, turns, Date.now());
    },
    // Map of player id -> { won, monsLeft, redLeft, turns } for a room's players on a day.
    roomResults: (room, date) => new Map(roomResults.all(room, date).map((row) => [row.player_id, toResult(row)])),
    // Days on which anyone in the room finished a battle, newest first (up to `until`).
    roomDates: (room, until) => roomDates.all(room, until).map((row) => row.date),
    // Players in the room with a result from `from` up to (not including) `to`.
    recentPlayers: (room, from, to) => recentPlayers.all(room, from, to).map((row) => row.player_id),
    roomsWithResults: (date) => roomsWithResults.all(date).map((row) => row.room),
    // Map of player id -> { wins, losses, monsLeft, turns, played } for a month ('YYYY-MM').
    monthTotals: (room, month) => new Map(monthTotals.all(room, `${month}-01`, `${month}-31`).map((row) => [row.player_id, {
      wins: Number(row.wins), losses: Number(row.losses), monsLeft: Number(row.mons_left), turns: Number(row.turns), played: Number(row.played),
    }])),
    roomsInMonth: (month) => roomsInMonth.all(`${month}-01`, `${month}-31`).map((row) => row.room),

    getCard: (guildId, date) => {
      const row = getCard.get(guildId, date);
      return row ? { channelId: row.channel_id, messageId: row.message_id } : null;
    },
    saveCard: (guildId, date, channelId, messageId) => { putCard.run(guildId, date, channelId, messageId); },
    recapPosted: (guildId, date) => Boolean(getRecap.get(guildId, date)),
    markRecapPosted: (guildId, date) => { putRecap.run(guildId, date, Date.now()); },
    getSetting: (key) => getSetting.get(key)?.value ?? null,
    setSetting: (key, value) => { putSetting.run(key, String(value)); },

    close: () => db.close(),
  };
}
