// Vercel 서버리스 함수 진입점.
// server.js에서 만든 Express 앱을 그대로 가져와 요청을 처리합니다.
// (server.js는 이 파일이 require될 때 app.listen()을 부르지 않도록 되어 있습니다 - require.main===module 가드 참고)
// vercel.json의 rewrites 설정으로 "/api/(.*)" 로 들어오는 모든 요청이 이 함수로 전달되고,
// req.url은 원래 경로(/api/molit/trades 등) 그대로 유지되므로 Express 라우팅이 그대로 동작합니다.
module.exports = require("../server");
