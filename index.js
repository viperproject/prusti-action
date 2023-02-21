const core = require("@actions/core"),
  tc = require("@actions/tool-cache"),
  exec = require("@actions/exec");

async function setup(actionConfig) {
  // TODO: use version
  const releaseURL = "https://github.com/viperproject/prusti-dev/releases/download/v-2023-02-20-1926/prusti-release-ubuntu.zip";
  const zipPath = await tc.downloadTool(releaseURL);
  const extractedPath = await tc.extractZip(zipPath, "prusti-release-extracted");
  const cachedPath = await tc.cacheDir(extractedPath, "prusti", "version");
  core.addPath(cachedPath);
  const exitCode = await exec.exec("prusti-rustc", ["--version"]);
  if (exitCode != 0) {
    throw `setup failed: prusti-rustc exited with non-zero code ${exitCode}`;
  }
}

async function verify(actionConfig) {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  if (actionConfig.verifyCrate) {
    exitCode = await exec.exec("cargo-prusti", [
      "--message-format=json",
    ], {
      cwd: actionConfig.path,
      listeners: {
        stdout: (data) => { stdout += data.toString(); },
        stderr: (data) => { stderr += data.toString(); },
      },
      ignoreReturnCode: true,
    });
  } else {
    exitCode = await exec.exec("prusti-rustc", [
      "--edition=2018",
      "--error-format=json",
      actionConfig.path,
    ], {
      listeners: {
        stdout: (data) => { stdout += data.toString(); },
        stderr: (data) => { stderr += data.toString(); },
      },
      ignoreReturnCode: true,
    });
  }
  if (exitCode != 0) {
    core.setFailed("Prusti exited with a non-zero exit code");
  }
  return stdout.split("\n");
}

async function processMessages(actionConfig, messages) {
  for (const messageJSON of messages) {
    let message;
    try {
      message = JSON.parse(messageJSON);
    } catch (error) {
      // ignore non-JSON messages
      continue;
    }
    if (!message) continue;

    // when running cargo, the message is wrapped in an additional layer
    // see https://doc.rust-lang.org/cargo/reference/external-tools.html
    if (actionConfig.verifyCrate) {
      if (message.reason !== "compiler-message") continue;
      message = message.message;
      if (!message) continue;
    }

    // at this point we expect a message from rustc
    // see https://doc.rust-lang.org/rustc/json.html

    // classify message
    let report;
    switch (message.level) {
    case "error":
    case "error: internal compiler error":
      report = core.error;
      break;
    case "warning":
      report = core.warning;
      break;
    default:
      report = core.notice;
    }

    // find a primary span, or at least *a* span
    let primarySpans = [];
    let allSpans = [];
    let displaySpan;
    function walkMessage(message) {
      if (message.spans) for (const span of message.spans) {
        if (span.is_primary) primarySpans.push(span);
        allSpans.push(span);
      }
      if (message.children) for (const child of message.children) {
        walkMessage(child);
      }
    }
    walkMessage(message);
    if (primarySpans.length > 0) displaySpan = primarySpans[0];
    else if (allSpans.length > 0) displaySpan = allSpans[0];

    // render and report message
    let annotationProperties = {
      title: message.message,
    };
    if (displaySpan) {
      annotationProperties.file = displaySpan.file_name;
      annotationProperties.startLine = displaySpan.line_start;
      annotationProperties.endLine = displaySpan.line_end;
      if (displaySpan.line_start != displaySpan.line_end) {
        annotationProperties.startColumn = displaySpan.column_start;
        annotationProperties.endColumn = displaySpan.column_end;
      }
    } else {
      annotationProperties.title = `(No span found for message:) ${annotationProperties.title}`;
    }
    report(message.rendered, annotationProperties);
  }
}

(async () => {
  try {
    // process input
    const actionConfig = {
      path: core.getIntpu("path", {required: true}),
      prustiVersion: core.getInput("version"),
      verifyCrate: core.getBooleanInput("verify-crate"),
    };

    // setup
    await core.group("setup Prusti", async () => await setup(actionConfig));

    // verify
    const messages = await core.group("verify with Prusti", async () => await verify(actionConfig));

    // process output
    await processMessages(actionConfig, messages);
  } catch (error) {
    core.setFailed(error.message);
  }
})();
