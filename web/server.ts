import { cleanDatabaseListeners } from "../common/database.js";
import http from "node:http";
import logError from "../modules/logging/errors.js";
import { createReadStream, promises as fileSystem } from "node:fs";
import { client } from "strife.js";
import config from "../common/config.js";
import constants from "../common/constants.js";
import appealRequest from "../modules/forms/showAppeal.js";
import pkg from "../package.json" assert { type: "json" };
import { fileURLToPath } from "node:url";
import path from "node:path";

const CSS = (await fileSystem.readFile("./web/style.css", "utf8")).replaceAll(
	"#000",
	"#" + constants.themeColor.toString(16),
);
const NOT_FOUND_PAGE = await fileSystem.readFile("./web/404.html", "utf8");
const SORA_DIRECTORY = path.dirname(
	fileURLToPath(import.meta.resolve("@fontsource-variable/sora")),
);
const server = http.createServer(async (request, response) => {
	try {
		const requestUrl = new URL(
			request.url ?? "",
			`http${"encrypted" in request.socket ? "s" : ""}://${request.headers.host}`,
		);

		const pathname = requestUrl.pathname.toLowerCase();
		switch (pathname) {
			case "/clean-database-listeners":
			case "/clean-database-listeners/": {
				if (requestUrl.searchParams.get("auth") !== process.env.CDBL_AUTH)
					response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");

				process.emitWarning("cleanDatabaseListeners called");
				await cleanDatabaseListeners();
				process.emitWarning("cleanDatabaseListeners ran");
				response.writeHead(200, { "content-type": "text/plain" }).end("Success");

				return;
			}
			case "/ban-appeal":
			case "/ban-appeal/": {
				return await appealRequest(request, response);
			}
			case "/style.css": {
				return response.writeHead(200, { "content-type": "text/css" }).end(CSS);
			}
			case "/icon.png": {
				const options = { extension: "png", forceStatic: true, size: 128 } as const;
				return response
					.writeHead(301, {
						location:
							config.guild.iconURL(options) ?? client.user.displayAvatarURL(options),
					})
					.end();
			}
			case "":
			case "/": {
				return response
					.writeHead(301, {
						location: config.guild.features.includes("DISCOVERABLE")
							? `https://discord.com/servers/${config.guild.id}`
							: pkg.homepage,
					})
					.end();
			}
		}

		const segments = pathname.split("/");
		if (segments[1] === "sora") {
			const filePath = path.join(SORA_DIRECTORY, segments.slice(2).join("/"));
			if (!(await fileSystem.access(filePath).catch(() => true)))
				return createReadStream(filePath).pipe(response);
		}
		response.writeHead(404, { "content-type": "text/html" }).end(NOT_FOUND_PAGE);
	} catch (error) {
		response.writeHead(500).end("Internal Server Error");
		await logError(error, request.url ?? "");
	}
});

await new Promise<void>((resolve) => server.listen(process.env.PORT, resolve));
console.log("Server up!");
export default server;
