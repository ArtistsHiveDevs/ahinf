const express = require('express');
const cors = require('cors');
const {
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
  CreateUserPoolCommand,
  ListUserPoolClientsCommand,
  CreateUserPoolClientCommand,
  AdminConfirmSignUpCommand,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const path = require('path');

const PORT = process.env.PORT || 9230;
const REGION = process.env.AWS_REGION || 'us-east-1';
const COGNITO_ENDPOINT = process.env.COGNITO_ENDPOINT || 'http://cognito-local:9229';
// Endpoint reachable from the browser (cognito-local's port published to the host)
const COGNITO_PUBLIC_ENDPOINT = process.env.COGNITO_PUBLIC_ENDPOINT || 'http://localhost:9229';

const POOL_NAME = 'artist-hive-local';
const CLIENT_NAME = 'artist-hive-local-client';

const client = new CognitoIdentityProviderClient({
  region: REGION,
  endpoint: COGNITO_ENDPOINT,
  credentials: {
    accessKeyId: 'local',
    secretAccessKey: 'local',
  },
});

async function findUserPool() {
  const { UserPools = [] } = await client.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  return UserPools.find((pool) => pool.Name === POOL_NAME);
}

async function createUserPool() {
  const { UserPool } = await client.send(
    new CreateUserPoolCommand({
      PoolName: POOL_NAME,
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true,
        },
      },
      Schema: [
        { Name: 'email', Required: true, Mutable: true },
        { Name: 'given_name', Required: true, Mutable: true },
        { Name: 'family_name', Required: true, Mutable: true },
        { Name: 'phone_number', Required: false, Mutable: true },
        { Name: 'preferred_username', Required: false, Mutable: true },
      ],
    })
  );
  return UserPool;
}

async function findUserPoolClient(userPoolId) {
  const { UserPoolClients = [] } = await client.send(
    new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60 })
  );
  return UserPoolClients.find((c) => c.ClientName === CLIENT_NAME);
}

async function createUserPoolClient(userPoolId) {
  const { UserPoolClient } = await client.send(
    new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: CLIENT_NAME,
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
    })
  );
  return UserPoolClient;
}

async function ensureUserPool() {
  let pool = await findUserPool();
  if (!pool) {
    console.log(`[cognito-admin] Creando user pool "${POOL_NAME}"...`);
    pool = await createUserPool();
  }

  let poolClient = await findUserPoolClient(pool.Id);
  if (!poolClient) {
    console.log(`[cognito-admin] Creando app client "${CLIENT_NAME}"...`);
    poolClient = await createUserPoolClient(pool.Id);
  }

  return {
    userPoolId: pool.Id,
    userPoolClientId: poolClient.ClientId,
    userPoolEndpoint: COGNITO_PUBLIC_ENDPOINT,
    region: REGION,
  };
}

async function waitForCognitoLocal(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.send(new ListUserPoolsCommand({ MaxResults: 1 }));
      return;
    } catch (error) {
      console.log(`[cognito-admin] Esperando a cognito-local (${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('cognito-local no respondió a tiempo');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let setupPromise;

function getConfig() {
  if (!setupPromise) {
    setupPromise = waitForCognitoLocal().then(ensureUserPool);
  }
  return setupPromise;
}

app.get('/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json(config);
  } catch (error) {
    console.error('[cognito-admin] Error obteniendo config:', error);
    res.status(503).json({ message: 'cognito-local no está disponible todavía' });
  }
});

app.post('/confirm', async (req, res) => {
  const { username } = req.body || {};

  if (!username) {
    return res.status(400).json({ message: 'username es requerido' });
  }

  try {
    const { userPoolId } = await getConfig();

    await client.send(
      new AdminConfirmSignUpCommand({
        UserPoolId: userPoolId,
        Username: username,
      })
    );

    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        // cognito-local exige el atributo `email` junto con `email_verified` para aceptar el cambio
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
        ],
      })
    );

    res.json({ confirmed: true });
  } catch (error) {
    console.error('[cognito-admin] Error confirmando usuario:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/users', async (req, res) => {
  try {
    const { userPoolId } = await getConfig();

    const { Users = [] } = await client.send(
      new ListUsersCommand({ UserPoolId: userPoolId })
    );

    res.json(
      Users.map((user) => ({
        username: user.Username,
        status: user.UserStatus,
        enabled: user.Enabled,
        created: user.UserCreateDate,
        attributes: Object.fromEntries(
          (user.Attributes || []).map((attr) => [attr.Name, attr.Value])
        ),
      }))
    );
  } catch (error) {
    console.error('[cognito-admin] Error listando usuarios:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/users/:username', async (req, res) => {
  const { username } = req.params;
  const { attributes } = req.body || {};

  if (!attributes || typeof attributes !== 'object') {
    return res.status(400).json({ message: 'attributes es requerido' });
  }

  try {
    const { userPoolId } = await getConfig();

    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: username,
        UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({
          Name,
          Value: String(Value),
        })),
      })
    );

    res.json({ updated: true });
  } catch (error) {
    console.error('[cognito-admin] Error actualizando usuario:', error);
    res.status(500).json({ message: error.message });
  }
});

app.delete('/users/:username', async (req, res) => {
  const { username } = req.params;

  try {
    const { userPoolId } = await getConfig();

    await client.send(
      new AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      })
    );

    res.json({ deleted: true });
  } catch (error) {
    console.error('[cognito-admin] Error eliminando usuario:', error);
    res.status(500).json({ message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[cognito-admin] Escuchando en puerto ${PORT}`);
  getConfig()
    .then((config) => console.log('[cognito-admin] User pool listo:', config))
    .catch((error) => console.error('[cognito-admin] Error en setup inicial:', error));
});
