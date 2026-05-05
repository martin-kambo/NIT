exports.handler = async (event) => {
  // Verify admin JWT
  const token = event.headers.authorization?.split(' ')[1];
  const admin = verifyAdminJWT(token);
  if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  
  const { action } = JSON.parse(event.body);
  
  if (action === 'get_stats') {
    return {
      statusCode: 200,
      body: JSON.stringify({
        totalVoters: await getTotalVoters(),
        totalVotesThisCycle: await getCurrentCycleVotes(),
        voterTurnout: await getTurnoutBySublocation(),
        topCandidates: await getTopCandidates(),
        recentActivity: await getRecentActivity()
      })
    };
  }
  
  if (action === 'reset_period') {
    await startNewVotingPeriod();
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }
  
  if (action === 'delete_user') {
    await deleteUser(event.body.userId);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }
};