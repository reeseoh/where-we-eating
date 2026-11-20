import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "WhereWeEatingData";
const MAX_SEARCHES = 3; // per room, so nobody can run up your bill

const get = async (id) => (await db.send(new GetCommand({ TableName: TABLE, Key: { id } }))).Item;
const put = (item) => db.send(new PutCommand({ TableName: TABLE, Item: item }));

// Grabs everything that belongs to one room
async function roomStuff(room) {
  let items = [], start;
  do {
    const page = await db.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: start }));
    items = items.concat(page.Items.filter(x => x.room === room));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

// Asks Amazon Location Service for restaurants near a spot
async function searchNearby(lat, lng, miles) {
  const url = "https://places.geo.us-east-1.amazonaws.com/v2/search-nearby?key=" + encodeURIComponent(process.env.LOCATION_KEY);
  const body = { QueryPosition: [lng, lat], QueryRadius: Math.round(miles * 1609), MaxResults: 20,
                 Filter: { IncludeCategories: ["restaurant"] }, Language: "en" };
  let res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 400) { // if the category filter isn't accepted, search everything and keep food places
    delete body.Filter; body.MaxResults = 50;
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  const data = await res.json();
  if (!res.ok) throw new Error("Restaurant search failed (" + res.status + "): " + (data.message || data.Message || JSON.stringify(data)));
  return (data.ResultItems || [])
    .filter(p => (p.Categories || []).some(c => /restaurant|dining|food|pizza|cafe|coffee|bar|grill|ice_cream|dessert|bakery/i.test(c.Id + c.Name)))
    .map(p => ({
      title: p.Title,
      cuisine: (p.FoodTypes || []).map(f => f.LocalizedName).slice(0, 2).join(", ") ||
               (p.Categories || []).map(c => c.LocalizedName || c.Name).slice(0, 1).join(""),
      address: p.Address ? p.Address.Label.replace(p.Title + ", ", "") : "",
      miles: p.Distance != null ? Math.round(p.Distance / 160.9) / 10 : null,
      openNow: p.OpeningHours && p.OpeningHours[0] ? p.OpeningHours[0].OpenNow : null
    }));
}

export const handler = async (event) => {
  let raw = event.body || "{}";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString();
  const req = JSON.parse(raw);
  const name = String(req.name || "").trim().slice(0, 20);
  const room = String(req.room || "").trim().toUpperCase();

  try {
    if (!name) return reply(400, { error: "Enter your name" });

    // CREATE a new room with a random 4-letter code
    if (req.action === "create") {
      const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O (they look like 1 and 0)
      let code;
      do { code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(""); }
      while (await get("room#" + code));
      await put({ id: "room#" + code, room: code, type: "room", host: name, searches: 0, createdAt: Date.now() });
      await put({ id: "member#" + code + "#" + name.toLowerCase(), room: code, type: "member", name });
      return reply(200, { room: code });
    }

    // Every other action needs a real room
    const roomItem = await get("room#" + room);
    if (!roomItem) return reply(404, { error: "No room with code " + room });

    // JOIN a friend's room
    if (req.action === "join") {
      await put({ id: "member#" + room + "#" + name.toLowerCase(), room, type: "member", name });
      return reply(200, { room });
    }

    // FIND restaurants near the host (host only, limited per room)
    if (req.action === "find") {
      if (roomItem.host !== name) return reply(403, { error: "Only " + roomItem.host + " (the host) can search" });
      if (roomItem.searches >= MAX_SEARCHES) return reply(429, { error: "This room already used its " + MAX_SEARCHES + " searches. Add spots by hand!" });
      const found = await searchNearby(Number(req.lat), Number(req.lng), Number(req.miles) || 2);
      roomItem.searches += 1;
      await put(roomItem);
      const existing = new Set((await roomStuff(room)).filter(x => x.type === "place").map(p => p.title.toLowerCase()));
      let added = 0;
      for (const p of found) {
        if (existing.has(p.title.toLowerCase())) continue;
        existing.add(p.title.toLowerCase());
        await put({ id: "place#" + randomUUID(), room, type: "place", addedBy: "search", createdAt: Date.now() + added, ...p });
        added++;
      }
      return reply(200, { added });
    }

    // ADD a spot by hand
    if (req.action === "add") {
      const title = String(req.title || "").trim().slice(0, 60);
      if (!title) return reply(400, { error: "Type a restaurant name" });
      await put({ id: "place#" + randomUUID(), room, type: "place", title, cuisine: String(req.cuisine || "").slice(0, 40),
                  address: "", miles: null, openNow: null, addedBy: name, createdAt: Date.now() });
      return reply(200, { ok: true });
    }

    // VOTE yes or no on a spot
    if (req.action === "vote") {
      await put({ id: "vote#" + room + "#" + name.toLowerCase() + "#" + req.placeId, room, type: "vote",
                  name: name.toLowerCase(), placeId: req.placeId, yes: !!req.yes });
      return reply(200, { ok: true });
    }

    // STATE: everything the screen needs (checked every few seconds)
    if (req.action === "state") {
      const all = await roomStuff(room);
      const members = all.filter(x => x.type === "member").map(m => m.name);
      const votes = all.filter(x => x.type === "vote");
      const places = all.filter(x => x.type === "place").sort((a, b) => a.createdAt - b.createdAt).map(p => {
        const pv = votes.filter(v => v.placeId === p.id);
        const yes = pv.filter(v => v.yes).map(v => v.name);
        return { ...p, yesCount: yes.length, voted: pv.length,
                 match: members.length >= 2 && yes.length === members.length,
                 myVote: pv.find(v => v.name === name.toLowerCase())?.yes };
      });
      const doneCount = members.filter(m => places.every(p => votes.some(v => v.placeId === p.id && v.name === m.toLowerCase()))).length;
      return reply(200, { room, host: roomItem.host, searchesLeft: MAX_SEARCHES - roomItem.searches, members, places, doneCount });
    }

    return reply(400, { error: "Unknown action" });
  } catch (err) {
    console.log(err);
    return reply(500, { error: err.message });
  }
};

const reply = (status, data) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data)
});
