// proxy-ui/src/plugins/append-to-title.js
function process($, ctx) {
  const { options, logger, request } = ctx;
  const suffix = options.suffix || " [via proxy]";

  const $title = $("title");
  if (!$title.length) {
    logger.info(
      `[plugin:append-to-title] no <title> on ${request && request.url}`
    );
    return;
  }

  const old = $title.text();
  const next = old + suffix;
  $title.text(next);

  logger.info(
    `[plugin:append-to-title] patched <title> on ${
      request && request.url
    }: "${old}" -> "${next}"`
  );
}

module.exports = { process };
