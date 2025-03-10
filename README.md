# Automated Liberdus Web Client Testing

## Usage

1. Make sure you have the dev containers extension for vscode.

2. Clone this repo and open it with vscode.

3. From the command palette run **Rebuild and Reopen in Container**.

4. Once the container builds, open a shell and run `./liberdus-setup.sh` to clone and configure repos for a local Liberdus test network and web-client-v2.

5. Run `./vnc-start.sh` in the workspace root directory to start a VNC server for remote desktop connection to the container.

6. Use a VNC client to connect on localhost to the port mentioned by the vnc server using the provided password.

7. Run `./liberdus-start.sh` in the workspace root directory to start a local Liberdus test network, the liberdus-proxy, and a http-server to host web-client-v2.

8. Navigate to the `playwright-tests` directory and run `npm install` to install dependencies.

9. Run `npx playwright open localhost:3000` in the `playwright-tests` directory to see the Liberdus network's progress on the Monitor Client in the VNC Client.

10. Run `npx playwright codegen localhost:8080` in the `playwright-tests` directory to create tests for the web-client-v2 in a graphical fashion with the VNC client. 

11. Run `./liberdus-stop.sh` in the workspace root directory to stop the local Liberdus test net, proxy, and web-client http-server in the container.

12. Run `./vnc-stop.sh` in the workspace root directory to stop the VNC server in the container.

## Manually Setting up a Local Liberdus Network with web-client-v2

1. Setup an environment with the following software:
   
   * Ubuntu 22.04 Jammy
   
   * C/C++ build-essentials (gcc, make, ld)
   
   * libssl-dev

   * pkg-config 1.8.0

   * Node.js 18.16.1
   
   * Rust 1.74
   
   * Python 3.x

2. Clone the following repos:
   
   * https://github.com/Liberdus/server.git
     
     * Navigate to the repo's root directory and run `npm install`.
   
   * https://github.com/shardus/tools-cli-shardus-network.git
     
     - Navigate to the repo's root directory and run `npm install`.
     
     - Run `npm link` in the root directory of this repo after installing dependencies to put the `shardus-network` command into the path.
   
   * https://github.com/Liberdus/web-client-v2.git
     
     * No dependencies to install.
   
   * https://github.com/Liberdus/liberdus-proxy.git
     
     * Dependencies are installed upon starting it later.

3. Start a local network of Liberdus nodes.
   
   * Navigate to the `Liberdus/server` repo and run `shardus-network start 10` to start a local network of 10 nodes.
     
     * The minimum number of nodes needed to process transactions is defined by the `minNodes` property in `server/src/config/index.ts`:
       
       ```js
       ...
       minNodes: process.env.minNodes ? parseInt(process.env.minNodes) : 10,
       ...
       ```

4. Configure and start the Liberdus proxy.
   
   * Navigate to the `Liberdus/liberdus-proxy` repo and change the following files:
     
     * Set the `ip`, `port`, and `publicKey` to the correct values for the local network's Archiver in `liberdus-proxy/src/archiver_seed.json`:
       
       ```json
       [{"publicKey":"758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3","port":4000,"ip":"127.0.0.1"}]
       ```
     
     * Disable `standalone_network` mode in `liberdus-proxy/src/config.json`:
       
       ```json
       ...
       "standalone_network": {
           "enabled":  false,
           "replacement_ip": "63.141.233.178"
       }
       ...
       ```
   
   * Start the proxy with `cargo run` and note the port it binds to.

5. Configure and serve the Liberdus web client with a local http-server.
   
   * Navigate to the `Liberdus/web-client-v2` repo and configure it to use the port bound by the local Liberdus proxy by editing `web-client-v2/network.js`:
     
     ```js
     ...
     "gateways": [
       {
         "protocol": "http",
         "host": "localhost",
         "port": 3030    
       },
     ]
     ...
     ```
   
   * Run `npx http-server` to serve the web client with a local http server.

6. Run automated tests against the web client.
   
   * Install Playwright browser binaries and their dependencies with:
     
     ```bash
     npx playwright install --with-deps
     ```
   
   * Run Playwright tests in UI mode with:
     
     ```bash
     npx playwright test --ui-port=8080 --ui-host=0.0.0.0
     ```
   
   * Use `codegen` to generate tests with:
     
     ```bash
     npx playwright codegen --ui-port=8080 --ui-host=0.0.0.0 [URL]
     ```
     
     * Emulate different viewport sizes with:
       
       ```bash
       npx playwright codegen --viewport-size="800,600" playwright.dev
       ```
     
     * Emulate devices with:
       
       ```bash
       npx playwright codegen --device="iPhone 13" playwright.dev
       ```
