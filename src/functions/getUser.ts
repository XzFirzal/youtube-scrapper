import axios from "axios";
import { YoutubeChannel } from "../structures/YoutubeChannel";
import { Util } from "../util/Util";

/**
 * Gets a user's channel data, behaves same as getChannel method but it uses the author name or id.
 * @param id The id or name of the owner.
 * @returns 
 */
export async function getUser(id: string) {
    const request = await axios.get<string>(`${Util.getYTUserURL()}/${id}?hl=en`)

    const json = JSON.parse(
        Util.getBetween(
            request.data,
            `var ytInitialData = `,
            ";</script>"
        )
    )

    return new YoutubeChannel(json)
}