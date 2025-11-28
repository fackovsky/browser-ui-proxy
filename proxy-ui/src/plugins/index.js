// proxy-ui/src/plugins/index.js
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const configPath = path.join(__dirname, "config.json");
let config = { htmlPlugins: [] };

function logLocal(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [PLUGINS] ${msg}`);
}

try {
  const raw = fs.readFileSync(configPath, "utf8");
  config = JSON.parse(raw);
  logLocal(`Loaded plugins config from ${configPath}`);
} catch (e) {
  logLocal(`Cannot read plugins config: ${e.message}`);
}

const plugins = [];

for (const pluginCfg of config.htmlPlugins || []) {
  if (!pluginCfg || pluginCfg.enabled === false) continue;

  const pluginPath = path.join(__dirname, `${pluginCfg.name}.js`);
  try {
    const pluginModule = require(pluginPath);
    if (typeof pluginModule.process !== "function") {
      logLocal(
        `Plugin ${pluginCfg.name} has no process() function, skipping`
      );
      continue;
    }
    plugins.push({
      name: pluginCfg.name,
      process: pluginModule.process,
      options: pluginCfg.options || {},
      match: pluginCfg.match || {}
    });
    logLocal(`Loaded plugin ${pluginCfg.name}`);
  } catch (e) {
    logLocal(`Failed to load plugin ${pluginCfg.name}: ${e.message}`);
  }
}

function rewriteHtml(html, ctx) {
  if (!html || typeof html !== "string") return html;
  const $ = cheerio.load(html);
  const logger = ctx.logger || console;

  for (const plugin of plugins) {
    try {
      plugin.process($, {
        options: plugin.options,
        match: plugin.match,
        logger,
        request: ctx.request,
        session: ctx.session || null
      });
    } catch (e) {
      logger.error(`Plugin ${plugin.name} failed: ${e.message}`);
    }
  }

  return $.html();
}

module.exports = { rewriteHtml };
