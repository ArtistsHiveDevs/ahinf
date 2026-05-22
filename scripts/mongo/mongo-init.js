// ============================================================
//  scripts/mongo-init.js
//  Crea la BD de dev con colecciones vacías.
//  Se ejecuta UNA VEZ cuando el volumen de Mongo se crea.
//  Los nombres de colección siguen la convención de Mongoose:
//  plural + minúsculas (Artist → artists, etc.)
// ============================================================

db = db.getSiblingDB("artisthive_dev");

// Usuario de app (no root)
db.createUser({
  user: "ah_app",
  pwd: "ah_dev",
  roles: [{ role: "readWrite", db: "artisthive_dev" }],
});

// Colecciones — se crean insertando y borrando un doc temporal
const collections = [
  "users",
  "entitydirectories",
  "artists",
  "albums",
  "events",
  "places",
  "prebookings",
  "followers",
  "profileclaims",
  "countries",
  "continents",
  "currencies",
  "languages",
  "allergies",
];

collections.forEach((name) => {
  db.createCollection(name);
  print(`✅ Colección creada: ${name}`);
});

print("");
print("🎵 artisthive_dev lista");
