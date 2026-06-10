const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const PORT = process.env.PORT || 9231;
const DATA_DIR = path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Evita que un path con ".." escape de DATA_DIR
function resolveSafePath(relativePath) {
  const normalized = path.normalize(relativePath).replace(/^([/\\])+/, '');
  const resolved = path.join(DATA_DIR, normalized);

  if (!resolved.startsWith(DATA_DIR)) {
    throw new Error('Path inválido');
  }

  return resolved;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const targetPath = resolveSafePath(req.body.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      cb(null, path.dirname(targetPath));
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(req.body.path));
  },
});

const upload = multer({ storage });

// Recorre DATA_DIR recursivamente y devuelve la lista de archivos con su path relativo
function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files = files.concat(listFiles(fullPath));
    } else {
      const relativePath = path.relative(DATA_DIR, fullPath).split(path.sep).join('/');
      const stats = fs.statSync(fullPath);
      files.push({ path: relativePath, size: stats.size, modified: stats.mtime });
    }
  }

  return files;
}

const app = express();
app.use(cors());
app.use('/files', express.static(DATA_DIR));
app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/list', (req, res) => {
  try {
    const files = listFiles(DATA_DIR).sort((a, b) => b.modified - a.modified);
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.body.path) {
    return res.status(400).json({ message: 'path es requerido' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'file es requerido' });
  }

  res.json({ path: req.body.path });
});

app.delete('/files/*', (req, res) => {
  try {
    const targetPath = resolveSafePath(req.params[0]);
    fs.rmSync(targetPath, { force: true });
    res.json({ deleted: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[storage-admin] Escuchando en puerto ${PORT}, almacenando en ${DATA_DIR}`);
});
