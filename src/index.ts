import fs from "fs";
import Axios from "axios";

const branchName = process.env.DRONE_BRANCH;
const commitHash = process.env.DRONE_COMMIT_SHA;

const portainerUrl = process.env.PLUGIN_PORTAINER_URL;
const portainerUsername = process.env.PLUGIN_PORTAINER_USERNAME;
const portainerPassword = process.env.PLUGIN_PORTAINER_PASSWORD;
const registry = process.env.PLUGIN_REGISTRY;
const images = process.env.PLUGIN_IMAGES;
const stackName = process.env.PLUGIN_STACK_NAME;
const endpoint = process.env.PLUGIN_ENDPOINT;
const composeEnvStr = process.env.PLUGIN_COMPOSE_ENVIRONMENT;
let dockerComposeFile = process.env.PLUGIN_COMPOSE_FILE;
const standalone = process.env.PLUGIN_STANDALONE;
const forcePull = process.env.PLUGIN_FORCE_PULL;

let additionalComposeEnv: { [key: string]: string } = {};

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

(async function() {
    // Authenticate with portainer and set the bearer token
    let response = await axios.post("/auth", {
        Username: portainerUsername,
        Password: portainerPassword,
    });

    if (response.status !== 200) {
        console.error("Login failed");
        console.error(response);
        process.exit(1);
    }

    const bearerToken = response.data.jwt as string;
    axios.defaults.headers.common["Authorization"] = "Bearer " + bearerToken;

    const endpointsReponse = await axios.get("/endpoints");

    if (response.status !== 200) {
        console.error("Get endpoints failed");
        console.error(response);
        process.exit(1);
    }

    // Find the endpoint id
    const localEp = endpointsReponse.data.find(
        (ep: { Id: number; Name: string }) => ep.Name === endpoint,
    );

    if (!localEp) {
        console.error(`Endpoint ${endpoint} not found`);
        process.exit(1);
    }

    // Check if the private registry is registered with portainer
    const registriesResponse = await axios.get("/registries");

    if (response.status !== 200) {
        console.error("Get registries failed");
        console.error(response);
        process.exit(1);
    }

    const registryFromList = registriesResponse.data.find(
        (reg: { Id: number; URL: string }) => reg.URL === registry,
    );

    if (!registryFromList) {
        console.error("Registry not configured in portainer");
        process.exit(1);
    }

    // Supply a 'X-Registry-Auth' header to work with portainer
    const xRegistryAuth = { registryId: registryFromList.Id };
    const xRegistryAuthStr = Buffer.from(JSON.stringify(xRegistryAuth)).toString(
        "base64",
    );

    const releaseTag = branchName + commitHash.substr(0, 8);

    await Promise.all(
        images.split(",").map(async (imageName: string) => {
            // Pull the image
            const imageResponse = await axios.post(
                `/endpoints/${localEp.Id}/docker/images/create`,
                {},
                {
                    headers: { "X-Registry-Auth": xRegistryAuthStr },
                    params: { fromImage: imageName, tag: releaseTag },
                },
            );

            if (imageResponse.status !== 200) {
                console.error("Could not pull image " + imageName);
                console.error(imageResponse);
                process.exit(1);
            }
        }),
    );

    let stackOptions = {};
    let swarmId = "";
    if (!standalone) {
        // Find the swarm id
        const swarmResponse = await axios.get(
            `/endpoints/${localEp.Id}/docker/swarm`,
        );

        if (swarmResponse.status !== 200) {
            console.error("Could not get swarm id");
            console.error(swarmResponse);
            process.exit(1);
        }

        swarmId = swarmResponse.data.ID;

        console.log(`Swarm id: ${swarmId}`);
        stackOptions = {
            params: { filters: { SwarmID: swarmId } },
        };
    }

    // Find the stack to update
    const stacksResponse = await axios.get("/stacks", stackOptions);

    if (stacksResponse.status !== 200) {
        console.error("Could not get list of stacks");
        console.error(stacksResponse);
        process.exit(1);
    }

    // Update the stack
    const stackToUpdate = stacksResponse.data.find(
        (stack: { Id: Number; Name: string }) => stack.Name === stackName,
    );

    // Read docker-compose.yml
    let composeFile: Buffer;

    try {
        composeFile = fs.readFileSync(dockerComposeFile);
    } catch (e) {
        console.error(`Could not read compose file ${dockerComposeFile}`);
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
        console.log(`Creating stack ${stackName}`);
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
            console.error("Could not create stack");
            console.error(stackCreateResponse);
            process.exit(1);
        }
    } else {
        console.log(`Updating stack ${stackToUpdate.Id} - ${stackToUpdate.Name}`);

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
            console.error("Could not update stack");
            console.error(stackUpdateResponse);
            process.exit(1);
        }
    }

    console.log("-- done --");
})();
