import {
	Routes,
	type RESTPostOAuth2AccessTokenResult,
	type RESTGetAPICurrentUserResult,
	type RESTPostOAuth2AccessTokenURLEncodedData,
	type RESTPostOAuth2RefreshTokenURLEncodedData,
	type RESTPostOAuth2RefreshTokenResult,
	ButtonStyle,
	ComponentType,
	GuildBan,
	time,
	roleMention,
	userMention,
} from "discord.js";
import { client } from "strife.js";
import config from "../../common/config.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import fileSystem from "node:fs/promises";
import { EXPIRY_LENGTH, strikeDatabase } from "../punishments/misc.js";
import constants from "../../common/constants.js";
import giveXp from "../xp/giveXp.js";
import { SpecialReminders, remindersDatabase } from "../reminders/misc.js";
import { RoleList, persistedRoles as persistedRoles } from "../roles/persisted.js";
import Mustache from "mustache";
import pkg from "../../package.json" assert { type: "json" };
import { getAppealComponents } from "./handleAppeal.js";
import appeals, { thread } from "./getAppeals.js";
import { stripMarkdown } from "../../util/markdown.js";

const NOT_FOUND_PAGE = await fileSystem.readFile("./web/404.html", "utf8");
const APPEAL_FRAME = await fileSystem.readFile("./modules/forms/frame.html", "utf8");
const ANSWER_PAGE = Mustache.render(APPEAL_FRAME, {
		content: await fileSystem.readFile("./modules/forms/answer.html", "utf8"),
	}),
	APPEAL_PAGE = Mustache.render(APPEAL_FRAME, {
		content: await fileSystem.readFile("./modules/forms/appeal.html", "utf8"),
	}),
	NOT_BANNED_PAGE = Mustache.render(APPEAL_FRAME, {
		content: await fileSystem.readFile("./modules/forms/notBanned.html", "utf8"),
	});

export default async function appealRequest(request: IncomingMessage, response: ServerResponse) {
	if (!process.env.CLIENT_SECRET)
		return response.writeHead(503, { "content-type": "text/html" }).end(NOT_FOUND_PAGE);

	const requestUrl = new URL(
		request.url ?? "",
		`http${"encrypted" in request.socket ? "s" : ""}://${request.headers.host}`,
	);
	const redirectUri = requestUrl.origin + requestUrl.pathname;
	const oAuthUrl = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
	// eslint-disable-next-line unicorn/string-content
	const htmlRedirect = `<meta http-equiv="refresh" content="0;url=${oAuthUrl}">`;

	// eslint-disable-next-line unicorn/no-negated-condition
	if (request.method !== "POST") {
		const code = new URLSearchParams(requestUrl.search).get("code");
		if (!code) return response.writeHead(303, { location: oAuthUrl }).end();

		const tokenData = (await client.rest
			.post(Routes.oauth2TokenExchange(), {
				body: new URLSearchParams({
					client_id: client.user.id,
					client_secret: process.env.CLIENT_SECRET,
					code,
					grant_type: "authorization_code",
					redirect_uri: redirectUri,
				} satisfies RESTPostOAuth2AccessTokenURLEncodedData),
				passThroughBody: true,
				headers: { "content-type": "application/x-www-form-urlencoded" },
				auth: false,
			})
			.catch(() => void 0)) as RESTPostOAuth2AccessTokenResult | undefined;
		if (!tokenData)
			return response.writeHead(401, { "content-type": "text/html" }).end(htmlRedirect);
		const user = (await client.rest.get(Routes.user(), {
			headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
			auth: false,
		})) as RESTGetAPICurrentUserResult;

		const appeal = appeals[userMention(user.id)];
		if (appeal)
			return response.writeHead(200, { "content-type": "text/html" }).end(
				Mustache.render(ANSWER_PAGE, {
					note: appeal.note && stripMarkdown(appeal.note),
					unbanned: appeal.unbanned,
					id: user.id,
					username: user.global_name ?? user.username,
					invite: pkg.homepage,
					date: appeal.date,
				}),
			);
		if (!(await config.guild.bans.fetch(user.id).catch(() => void 0)))
			return response.writeHead(403, { "content-type": "text/html" }).end(
				Mustache.render(NOT_BANNED_PAGE, {
					username: user.global_name ?? user.username,
					invite: pkg.homepage,
					id: user.id,
				}),
			);

		return response.writeHead(200, { "content-type": "text/html" }).end(
			Mustache.render(APPEAL_PAGE, {
				username: user.global_name ?? user.username,
				token: tokenData.refresh_token,
				id: user.id,
			}),
		);
	} else {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		await new Promise((resolve, reject) => request.on("end", resolve).on("error", reject));
		const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));

		const refreshToken = body.get("token");
		if (!refreshToken)
			return response.writeHead(401, { "content-type": "text/html" }).end(htmlRedirect);
		const tokenData = (await client.rest
			.post(Routes.oauth2TokenExchange(), {
				body: new URLSearchParams({
					client_id: client.user.id,
					client_secret: process.env.CLIENT_SECRET,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				} satisfies RESTPostOAuth2RefreshTokenURLEncodedData),
				passThroughBody: true,
				headers: { "content-type": "application/x-www-form-urlencoded" },
				auth: false,
			})
			.catch(() => void 0)) as RESTPostOAuth2RefreshTokenResult | undefined;
		if (!tokenData)
			return response.writeHead(401, { "content-type": "text/html" }).end(htmlRedirect);

		const rawUser = (await client.rest.get(Routes.user(), {
			headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
			auth: false,
		})) as RESTGetAPICurrentUserResult;
		const { user, reason } = await config.guild.bans
			.fetch(rawUser.id)
			.catch((): Partial<GuildBan> => ({}));
		if (!user)
			return response.writeHead(403, { "content-type": "text/html" }).end(
				Mustache.render(NOT_BANNED_PAGE, {
					username: rawUser.global_name ?? rawUser.username,
					invite: pkg.homepage,
					id: rawUser.id,
				}),
			);

		const strikes = strikeDatabase.data.filter((strike) => strike.user === user.id);
		const totalStrikeCount = strikes.reduce(
			(accumulator, { count, removed }) => count * Number(!removed) + accumulator,
			0,
		);
		const recentStrikeCount = strikes
			.filter((strike) => strike.date + EXPIRY_LENGTH > Date.now())
			.reduce((accumulator, { count, removed }) => count * Number(!removed) + accumulator, 0);
		const semiRecentStrikeCount = strikes
			.filter((strike) => strike.date + EXPIRY_LENGTH * 2 > Date.now())
			.reduce((accumulator, { count, removed }) => count * Number(!removed) + accumulator, 0);
		const persistant = await RoleList.findOne({ id: user.id });
		const unbanTime = remindersDatabase.data.find(
			(reminder) =>
				reminder.user === client.user.id &&
				reminder.id === SpecialReminders.Unban &&
				reminder.reminder === user.id,
		)?.date;

		const mention = user.toString();
		const fields = {
			ban: body.get("ban")?.trim(),
			unban: body.get("unban")?.trim(),
			misc: body.get("misc")?.trim(),
		};
		if (!fields.ban || !fields.unban)
			return response.writeHead(400, { "content-type": "text/html" }).end(
				Mustache.render(APPEAL_PAGE, {
					username: user.displayName,
					token: tokenData.refresh_token,
					id: user.id,
				}),
			);

		const message = await thread.send({
			embeds: [
				{
					title: "Ban Appeal",
					author: { name: user.tag, icon_url: user.displayAvatarURL() },
					description: mention,
					fields: [
						{
							name: "Persisted Roles",
							value:
								Object.entries(persistedRoles)
									.map(([name, ids]) => persistant?.[name] && [ids].flat()[0])
									.filter((role): role is string => !!role)
									.toSorted((one, two) =>
										config.guild.roles.comparePositions(one, two),
									)
									.map(roleMention)
									.join(" ") || "*No roles*",
							inline: false,
						},
						{ name: "Created Account", value: time(user.createdAt), inline: true },
						{
							name: "Auto Unban",
							value: unbanTime ? time(new Date(unbanTime)) : "Never",
							inline: true,
						},
						{
							name: "Strikes",
							value: `${totalStrikeCount.toLocaleString(
								"en-us",
							)} (${recentStrikeCount.toLocaleString(
								"en-us",
							)} in the past 3 weeks; ${semiRecentStrikeCount.toLocaleString(
								"en-us",
							)} in the past 6 weeks)`,
							inline: true,
						},
						{ name: constants.zws, value: constants.zws, inline: false },
						{
							name: "Mod’s Perspective",
							value: reason ?? constants.defaultPunishment,
							inline: !fields.misc,
						},
						{ name: "User’s Perspective", value: fields.ban, inline: true },
						{ name: "Appeal", value: fields.unban, inline: true },
						...(fields.misc
							? [{ name: "Misc", value: fields.misc, inline: true }]
							: []),
					],
				},
			],

			components: [
				getAppealComponents(),
				{
					type: ComponentType.ActionRow,
					components: [
						{
							style: ButtonStyle.Secondary,
							type: ComponentType.Button,
							customId: `${user.id}_userInfo`,
							label: "User Info",
						},
						{
							style: ButtonStyle.Secondary,
							type: ComponentType.Button,
							customId: `${user.id}_xp`,
							label: "XP",
						},
						...(totalStrikeCount
							? [
									{
										style: ButtonStyle.Secondary,
										type: ComponentType.Button,
										customId: `${user.id}_viewStrikes`,
										label: "Strikes",
									} as const,
							  ]
							: []),
					],
				},
			],
		});
		await giveXp(user, message.url);

		const date = new Date(Date.now() + 691_200_000).toDateString();
		appeals[mention] = { date, unbanned: false, note: undefined };

		return response
			.writeHead(200, { "content-type": "text/html" })
			.end(Mustache.render(ANSWER_PAGE, { username: user.displayName, date, id: user.id }));
	}
}
