/** @type {import('pm2').StartOptions[]} */
module.exports = {
  apps: [
    {
      name: "providers",
      cwd: "./apps/service-providers",
      script: "../../node_modules/.bin/tsx",
      args: "watch src/index.ts",
      interpreter: "none",
      watch: false, // tsx watch handles its own reload
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "planner",
      cwd: "./apps/service-planner",
      script: "../../node_modules/.bin/tsx",
      args: "watch src/index.ts",
      interpreter: "none",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "orchestrator",
      cwd: "./apps/service-orchestrator",
      script: "../../node_modules/.bin/tsx",
      args: "watch src/index.ts",
      interpreter: "none",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "gateway",
      cwd: "./apps/gateway",
      script: "../../node_modules/.bin/tsx",
      args: "watch src/index.ts",
      interpreter: "none",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "web",
      cwd: "./apps/web",
      script: "../../node_modules/.bin/vite",
      args: "--host",
      interpreter: "none",
      watch: false,
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
