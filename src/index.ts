import fs from "fs";
import Axios, { AxiosHeaders } from "axios";

const branchName = process.env.DRONE_BRANCH;
const commitHash = process.env.DRONE_COMMIT_SHA;

const portainerUrl = process.env.PLUGIN_PORTAINER_URL;
const portainerUsername = process.env.PLUGIN_PORTAINER_USERNAME;
const portainerPassword = process.env.PLUGIN_PORTAINER_PASSWORD;
const images = process.env.PLUGIN_IMAGES ?? "";
const stackName = process.env.PLUGIN_STACK_NAME;
const endpoint = process.env.PLUGIN_ENDPOINT;
const composeEnvStr = process.env.PLUGIN_COMPOSE_ENVIRONMENT;
let dockerComposeFile = process.env.PLUGIN_COMPOSE_FILE;
const standalone = process.env.PLUGIN_STANDALONE ?? false;
const forcePull = process.env.PLUGIN_FORCE_PULL ?? false;

let additionalComposeEnv: Record<string, string> = {};

if (composeEnvStr && composeEnvStr !== "") {
  additionalComposeEnv = JSON.parse(composeEnvStr);
}

if (!dockerComposeFile || dockerComposeFile === "") {
  dockerComposeFile = "docker-compose.yml";
}

const axios = Axios.create({
  baseURL: `${portainerUrl}/api`,
  validateStatus: function(status) {
    return status < 5000;
  },
});

let registries: { Id: number; URL: string }[] | undefined = undefined;

const getRegistries = async () => {
  if (registries) return registries;

  console.log("[INFO] Retrieving registries...");
  const registriesResponse = await axios.get<{ Id: number; URL: string }[]>(
    "/registries",
  );

  if (registriesResponse.status !== 200) {
    console.error("[ERROR] Get registries failed");
    console.error(registriesResponse);
    process.exit(1);
  } else console.log("[INFO] Success.");

  registries = registriesResponse.data;

  return registries;
};

const getRegistryAuth = async (registryUrl: string) => {
  const currentRegistries = await getRegistries();

  const registryFromList = currentRegistries.find(
    (reg) => reg.URL === registryUrl,
  ) as { Id: number; URL: string } | undefined;

  if (!registryFromList) {
    console.error(
      `[ERROR] Registry ${registryUrl} not configured in portainer`,
    );
    process.exit(1);
  } else
    console.log(
      `[INFO] Registry ${registryUrl} found with ID ${registryFromList.Id}`,
    );

  // Supply a 'X-Registry-Auth' header to work with portainer
  const xRegistryAuth = { registryId: registryFromList.Id };
  const xRegistryAuthStr = Buffer.from(JSON.stringify(xRegistryAuth)).toString(
    "base64",
  );

  return xRegistryAuthStr;
};

(async function() {
  if (!commitHash) {
    console.error("[ERROR] Commit hash not set.");
    process.exit(1);
  }

  const releaseTag = branchName + "-" + commitHash.substring(0, 8);

  console.log(
    "[INFO] Running drone-portainer plugin with the following params:",
  );
  console.log(`[INFO] \tPortainer URL: ${portainerUrl}`);
  console.log(`[INFO] \tPortainer Username: ${portainerUsername}`);
  console.log(`[INFO] \tImages: ${images.split(",").join(", ")}`);
  console.log(`[INFO] \tStack Name: ${stackName}`);
  console.log(`[INFO] \tEndpoint Name: ${endpoint}`);
  console.log(`[INFO] \tCompose Environment: ${composeEnvStr}`);
  console.log(`[INFO] \tDocker Compose File: ${dockerComposeFile}`);
  console.log(`[INFO] \tStandalone Mode: ${standalone}`);
  console.log(`[INFO] \tForce Pull: ${forcePull}\n`);
  console.log(`[INFO] \tCommit Hash: ${commitHash}`);
  console.log(`[INFO] \tBranch: ${branchName}\n`);

  // Authenticate with portainer and set the bearer token
  console.log("[INFO] Trying to autheticate...");
  let response = await axios.post("/auth", {
    Username: portainerUsername,
    Password: portainerPassword,
  });

  if (response.status !== 200) {
    console.error("[ERROR] Login failed");
    console.error(response);
    process.exit(1);
  } else console.log("[INFO] Success.");

  const bearerToken = response.data.jwt as string;
  axios.defaults.headers.common["Authorization"] = "Bearer " + bearerToken;

  console.log("[INFO] Retrieving endpoints...");
  const endpointsReponse = await axios.get("/endpoints");

  if (response.status !== 200) {
    console.error("[ERROR] Get endpoints failed");
    console.error(response);
    process.exit(1);
  } else console.log("[INFO] Success.");

  // Find the endpoint id
  const localEp = endpointsReponse.data.find(
    (ep: { Id: number; Name: string }) => ep.Name === endpoint,
  );

  if (!localEp) {
    console.error(`[ERROR] Endpoint ${endpoint} not found`);
    process.exit(1);
  } else console.log(`[INFO] Endpoint ${endpoint} found with ID ${localEp.Id}`);

  if (images && images != "") {
    console.log("[INFO] Pulling Images...");

    await Promise.all(
      images.split(",").map(async (imageName: string) => {
        console.log(`[INFO] Requesting Image ${imageName}...`);

        // Pull the image
        const imageRequestHeaders = new AxiosHeaders();

        const registry = imageName.split("/")[0];

        if (registry != "docker.io") {
          const registryAuth = await getRegistryAuth(registry);

          imageRequestHeaders.set("X-Registry-Auth", registryAuth);
        }

        const imageResponse = await axios.post(
          `/endpoints/${localEp.Id}/docker/images/create`,
          {},
          {
            headers: imageRequestHeaders,
            params: { fromImage: imageName, tag: releaseTag },
          },
        );

        if (imageResponse.status !== 200) {
          console.error("[ERROR] Could not pull image " + imageName);
          console.error(imageResponse);
          process.exit(1);
        } else console.log(`[INFO] Success. Pulled ${imageName}.`);
      }),
    );

    console.log("[INFO] Success. Pulled all images.");
  }

  console.log(`[INFO] Standalone Mode Enabled: ${standalone}`);

  let stackOptions = {};
  let swarmId = "";
  if (!standalone) {
    // Find the swarm id
    console.log("[INFO] Retrieving Swarm ID by Endpoint ID...");
    const swarmResponse = await axios.get(
      `/endpoints/${localEp.Id}/docker/swarm`,
    );

    if (swarmResponse.status !== 200) {
      console.error("[ERROR] Could not get swarm id");
      console.error(swarmResponse);
      process.exit(1);
    } else console.log("[INFO] Success.");

    swarmId = swarmResponse.data.ID;

    console.log(`[INFO] Swarm ID: ${swarmId}`);

    stackOptions = {
      params: { filters: { SwarmID: swarmId } },
    };
  }

  // Find the stack to update
  console.log("[INFO] Retrieving stacks list...");
  const stacksResponse = await axios.get("/stacks", stackOptions);

  if (stacksResponse.status !== 200) {
    console.error("[ERROR] Could not get list of stacks");
    console.error(stacksResponse);
    process.exit(1);
  } else console.log("[INFO] Success.");

  // Update the stack
  const stackToUpdate = stacksResponse.data.find(
    (stack: { Id: Number; Name: string }) => stack.Name === stackName,
  );

  // Read docker-compose.yml
  let composeFile: Buffer;

  try {
    composeFile = fs.readFileSync(dockerComposeFile);
  } catch (e) {
    console.error(`[ERROR] Could not read compose file ${dockerComposeFile}`);
    console.error(e);
    process.exit(1);
  }

  let urlPrefix = branchName == "main" ? "" : branchName + ".";

  let composeEnvArray = [
    { name: "RELEASE_TAG", value: releaseTag },
    { name: "URL_PREFIX", value: urlPrefix },
    { name: "STACK_NAME", value: stackName },
  ];

  if (additionalComposeEnv) {
    Object.keys(additionalComposeEnv).forEach((k) =>
      composeEnvArray.push({ name: k, value: additionalComposeEnv[k] }),
    );
  }

  if (!stackToUpdate) {
    console.log(`[INFO] Creating stack ${stackName}`);
    let operationType = 2;

    let stackCreateOptions = {
      Name: stackName,
      StackFileContent: composeFile.toString(),
      Env: composeEnvArray,
      Prune: true,
    };

    if (!standalone) {
      operationType = 1;
      const swarmOptions = { SwarmID: swarmId };
      stackCreateOptions = { ...stackCreateOptions, ...swarmOptions };
    }

    const stackCreateResponse = await axios.post(
      `/stacks?type=${operationType}&method=string&endpointId=${localEp.Id}`,
      stackCreateOptions,
    );

    if (stackCreateResponse.status !== 200) {
      console.error("[ERROR] Could not create stack");
      console.error(stackCreateResponse);
      process.exit(1);
    }
  } else {
    console.log(
      `[INFO] Updating stack ${stackToUpdate.Name} (ID:${stackToUpdate.Id})`,
    );

    const stackUpdateResponse = await axios.put(
      `/stacks/${stackToUpdate.Id}?endpointId=${localEp.Id}`,
      {
        id: stackToUpdate.Id,
        StackFileContent: composeFile.toString(),
        Env: composeEnvArray,
        Prune: true,
        PullImage: !!forcePull,
      },
    );

    if (stackUpdateResponse.status !== 200) {
      console.error("[ERROR] Could not update stack");
      console.error(stackUpdateResponse);
      process.exit(1);
    }
  }

  console.log("[INFO] Done.");
})();
