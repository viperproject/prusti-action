const core = require("@actions/core"),
  tc = require("@actions/tool-cache"),
  exec = require("@actions/exec"),
  path = require("path");
const { Octokit } = require("@octokit/rest");

async function setup(actionConfig) {
  console.log(`downloading release ${actionConfig.version}`);

  let platformId;
  switch (process.platform) {
  case "darwin":
    platformId = "macos";
    break;
  case "linux":
    platformId = "ubuntu";
    break;
  case "win32":
    platformId = "windows";
    break;
  default:
    throw `unsupported platform ${process.platform}`;
  }
  const releaseURL = `https://github.com/viperproject/prusti-dev/releases/download/${actionConfig.version}/prusti-release-${platformId}.zip`;
  const zipPath = await tc.downloadTool(releaseURL);
  const extractedPath = await tc.extractZip(zipPath);
  core.addPath(extractedPath);

  await exec.exec("ls", [extractedPath]);
  await exec.exec("chmod", ["+x", "prusti-driver"], {cwd: extractedPath});
  await exec.exec("chmod", ["+x", "prusti-rustc"], {cwd: extractedPath});
  await exec.exec("chmod", ["+x", "prusti-server"], {cwd: extractedPath});
  await exec.exec("chmod", ["+x", "prusti-server-driver"], {cwd: extractedPath});
  await exec.exec("chmod", ["+x", "cargo-prusti"], {cwd: extractedPath});
  await exec.exec("chmod", ["+x", "viper_tools/z3/bin/z3"], {cwd: extractedPath});
  await exec.exec("rustup", ["show"], {cwd: extractedPath});

  // TODO: cache directory?
  //const cachedPath = await tc.cacheDir(extractedPath, "prusti", "version");

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
      "--features", "prusti-contracts/prusti",
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

    if (message.message === "aborting due to previous error"
      || (message.message.startsWith("aborting due to ") && message.message.endsWith(" previous errors"))) {
      // ignore: this only adds noise to the annotations
      continue;
    }

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
      let pathToRoot;
      if (actionConfig.verifyCrate) {
        pathToRoot = actionConfig.path;
      } else {
        pathToRoot = path.dirname(actionConfig.path);
      }
      annotationProperties.file = path.join(actionConfig.annotationPath, pathToRoot, displaySpan.file_name);
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
      path: core.getInput("path", {required: true}),
      version: core.getInput("version"),
      verifyCrate: core.getBooleanInput("verify-crate"),
      annotationPath: core.getInput("annotationPath"),
      token: core.getInput("token"),
    };

    if (actionConfig.version === "nightly") {
      let octokit;
      if (actionConfig.token) {
        octokit = new Octokit({ auth: token });
      } else {
        octokit = new Octokit();
      }
      const releases = await octokit.rest.repos.listReleases({
        owner: "viperproject",
        repo: "prusti-dev",
        per_page: 1,
      });
      actionConfig.version = releases.data[0].tag_name;
    }

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
