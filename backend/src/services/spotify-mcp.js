const SpotifyWebApi = require('spotify-web-api-node');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

const spotifyService = {
  async connect(userId) {
    const scopes = [ 'user-read-private',       
        'user-read-email',         
        'playlist-read-private',   
        'user-library-read',      
        'user-top-read',          
        'user-read-playback-state',  
        'user-modify-playback-state'  
        ];
    const authorizeURL = spotifyApi.createAuthorizeURL(scopes, userId);
    return authorizeURL;
  },

  async handleCallback(code) {
    try {
      const data = await spotifyApi.authorizationCodeGrant(code);
      const { access_token, refresh_token } = data.body;
      spotifyApi.setAccessToken(access_token);
      spotifyApi.setRefreshToken(refresh_token);
      return { access_token, refresh_token };
    } catch (error) {
      console.error('Error during Spotify callback:', error);
      throw new Error('Failed to handle Spotify callback');
    }
  },

  async processCommand(prompt, userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.spotifyTokens) {
      return { requiresConnection: true };
    }
      const tokens = JSON.parse(user.spotifyTokens);
  try {
   

        // ✅ STEP 3: Object se tokens nikal kar `spotifyApi` mein set karein
        spotifyApi.setAccessToken(tokens.access_token);
        spotifyApi.setRefreshToken(tokens.refresh_token);

    
    // Simple command processing based on keywords
    if (prompt.toLowerCase().includes('search for a song')) {
      const query = prompt.split('search for a song')[1].trim();
      const searchResults = await spotifyApi.searchTracks(query);
      const simplifiedTracks = searchResults.body.tracks.items.map(track => ({
          name: track.name,
          artists: track.artists.map(artist => artist.name).join(', '), // Saare artists ke naam jor do
          album: track.album.name,
          url: track.external_urls.spotify // Gaane ka link
      }));
      return simplifiedTracks.slice(0, 5); // Sirf top 5 results bhejo taake AI pareshan na ho
    }

   } catch (error) {
      if (error.statusCode === 401) { // 401 ka matlab hai "Unauthorized" (token expired)
        console.log("Access token expired. Refreshing now...");
        
        try {
          // ✅ STEP 3: Naya token hasil karein
          const data = await spotifyApi.refreshAccessToken();
          const newAccessToken = data.body['access_token'];
          console.log("New access token obtained:", newAccessToken);

          // Naye token ko `spotifyApi` mein set karein
          spotifyApi.setAccessToken(newAccessToken);

          // ✅ STEP 4: Naye token ko DATABASE MEIN SAVE KAREIN
          const updatedTokens = {
            access_token: newAccessToken,
            refresh_token: tokens.refresh_token, // Refresh token wohi rehta hai
          };
          await prisma.user.update({
            where: { id: userId },
            data: { spotifyTokens: JSON.stringify(updatedTokens) },
          });

          // ✅ STEP 5: Original command ko NAYE token ke sath dobara try karein
          console.log("Retrying the original command with the new token...");
          return await this.executeApiCall(prompt);

        } catch (refreshError) {
          console.error("Could not refresh the access token!", refreshError);
          return { error: "Could not refresh Spotify connection. Please reconnect manually." };
        }
         }
      
      // Agar koi aur error hai, to usay bhej dein
      console.error("A different error occurred:", error);
      return { error: "An unexpected error occurred with Spotify." };
    }
  },

  async executeApiCall(prompt) {
    if (prompt.toLowerCase().includes('search for a song')) {
      const query = prompt.split('search for a song')[1].trim();
      const searchResults = await spotifyApi.searchTracks(query);

      
      // ✅ NAYA AUR BEHTAR CODE:
      // Poori list mein se sirf zaroori cheezein nikalo
      const simplifiedTracks = searchResults.body.tracks.items.map(track => ({
          name: track.name,
          artists: track.artists.map(artist => artist.name).join(', '), // Saare artists ke naam jor do
          album: track.album.name,
          url: track.external_urls.spotify // Gaane ka link
      }));

      // Sirf top 5 results bhejo taake AI pareshan na ho
      return simplifiedTracks.slice(0, 5);
    }
    
    // ... yahan aur commands aa sakte hain ...
    return { message: 'Command not recognized' };
}
};



module.exports = spotifyService;
