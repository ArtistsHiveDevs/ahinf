// ============================================================
//  scripts/mongo-seed.js
//  Carga datos desde archivos JSON en data/db
//  Busca archivos con prefijo artisthive_dev, extrae el nombre
//  de la colección y carga los datos correspondientes.
//
//  USO (desde la raíz del proyecto en Windows):
//  docker exec -i ah_mongo mongosh -u admin -p devpassword --authenticationDatabase admin < scripts/mongo/mongo-seed.js
// ============================================================

// Cambiar a la base de datos
db = db.getSiblingDB("artisthive_dev");

// Función para extraer el nombre de la colección del nombre del archivo
function extractCollectionName(filename) {
  // Formato esperado: artisthive_dev.collectionname.json
  // o artisthive_dev.collectionname_suffix.json (donde solo queremos collectionname)

  // Remover la extensión .json
  const nameWithoutExt = filename.replace(".json", "");

  // Dividir por puntos
  const parts = nameWithoutExt.split(".");

  if (parts.length < 2 || parts[0] !== "artisthive_dev") {
    return null; // No es un archivo válido
  }

  // Obtener la parte del nombre de la colección (entre el primer y último punto)
  const collectionPart = parts[1];

  // Si contiene guión bajo, tomar solo la primera parte
  // Ejemplo: entitydirectories_artist -> entitydirectories
  const collectionName = collectionPart.split("_")[0];

  return collectionName;
}

// Lista de rutas de archivos relativas a /data/db/
// Nota: mongosh no tiene acceso a fs, por lo que listamos manualmente
const dataFilePaths = [
  "artisthive_dev.artists.json",
  "artisthive_dev.entitydirectories_artist.json",
  "artisthive_dev.entitydirectories_places.json",
  "artisthive_dev.places.json",
  "parametrics/artisthive_dev.allergies.json",
  "parametrics/artisthive_dev.continents.json",
  "parametrics/artisthive_dev.countries.json",
  "parametrics/artisthive_dev.currencies.json",
  "parametrics/artisthive_dev.languages.json"
];

print("=".repeat(60));
print("Iniciando carga de datos desde archivos JSON");
print("=".repeat(60));

dataFilePaths.forEach((relativePath) => {
  // Extraer el nombre del archivo de la ruta
  const fileName = relativePath.split("/").pop();
  const fullPath = "/data/db/" + relativePath;

  const collectionName = extractCollectionName(fileName);

  if (collectionName) {
    print(`\nCargando datos en la colección: ${collectionName} desde ${relativePath}`);

    try {
      // Leer el contenido del archivo usando cat (función nativa de mongosh)
      const fileContent = cat(fullPath);
      const data = JSON.parse(fileContent);

      // Verificar que sea un array
      if (Array.isArray(data)) {
        // Insertar los documentos en la colección
        if (data.length > 0) {
          const result = db[collectionName].insertMany(data);
          const count = result.insertedIds ? Object.keys(result.insertedIds).length : data.length;
          print(`  ✓ ${count} documentos insertados en ${collectionName}`);
        } else {
          print(`  ⚠ El archivo está vacío`);
        }
      } else {
        print(`  ✗ Error: El archivo no contiene un array JSON válido`);
      }
    } catch (error) {
      print(`  ✗ Error al procesar ${fileName}: ${error.message}`);
    }
  }
});

print("=".repeat(60));
print("Carga de datos completada");
print("=".repeat(60));

// Mostrar resumen de colecciones
print("\nResumen de colecciones:");
db.getCollectionNames().forEach((name) => {
  const count = db[name].countDocuments();
  print(`  - ${name}: ${count} documentos`);
});
