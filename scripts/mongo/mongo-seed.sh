#!/bin/bash
# ============================================================
#  scripts/mongo-seed.sh
#  Carga datos desde archivos JSON en /data/db
#  usando mongoimport
#
#  USO (desde la raíz del proyecto en Windows):
#  docker exec ah_mongo bash /data/db/mongo-seed.sh
# ============================================================

DB_NAME="artisthive_dev"
DB_USER="admin"
DB_PASS="devpassword"
DATA_DIR="/data/db"

# Lista de archivos a importar (rutas relativas a DATA_DIR)
FILES=(
  "artisthive_dev.artists.json:artists"
  "artisthive_dev.entitydirectories_artist.json:entitydirectories"
  "artisthive_dev.entitydirectories_places.json:entitydirectories"
  "artisthive_dev.places.json:places"
  "parametrics/artisthive_dev.allergies.json:allergies"
  "parametrics/artisthive_dev.continents.json:continents"
  "parametrics/artisthive_dev.countries.json:countries"
  "parametrics/artisthive_dev.currencies.json:currencies"
  "parametrics/artisthive_dev.languages.json:languages"
)

echo "============================================================"
echo "Iniciando carga de datos en MongoDB"
echo "============================================================"

for entry in "${FILES[@]}"; do
  # Dividir la entrada en archivo:colección
  IFS=':' read -r file_path collection <<< "$entry"
  full_path="$DATA_DIR/$file_path"

  echo ""
  echo "Importando $file_path -> colección: $collection"

  if [ -f "$full_path" ]; then
    mongoimport \
      --username="$DB_USER" \
      --password="$DB_PASS" \
      --authenticationDatabase=admin \
      --db="$DB_NAME" \
      --collection="$collection" \
      --file="$full_path" \
      --jsonArray \
      --drop

    if [ $? -eq 0 ]; then
      echo "  ✓ Importación exitosa"
    else
      echo "  ✗ Error en la importación"
    fi
  else
    echo "  ✗ Archivo no encontrado: $full_path"
  fi
done

echo ""
echo "============================================================"
echo "Carga de datos completada"
echo "============================================================"
