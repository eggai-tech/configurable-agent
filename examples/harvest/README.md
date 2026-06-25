## Harvest oauth integration

1. copy and fill the example env file

2. create an oauth app in harvest
https://id.getharvest.com/developers

3. set the oauth client id and secret in the .env file

4. get the harvest oauth token
```
dotenv -e examples/harvest/.env -- node examples/harvest/harvest-oauth.mjs
```
authorize the app and copy the env var values printed out in the server logs

5. set the token and the account id in the env file
