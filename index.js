import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField
} from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';

// Load environment variables
dotenv.config();

// Validate Discord token
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Error: DISCORD_TOKEN is not set in the environment variables');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
});

// Data storage
const inviteCounts = new Map(); // Tracks invite counts per user per guild
const userInviter = new Map(); // Maps invited members to their inviters
const invitesCache = new Map(); // Caches invite usage counts

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Register slash commands
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering slash commands:', error.message, error.stack);
  }
  
  // Cache existing invites and initialize counts
  for (const guild of client.guilds.cache.values()) {
    try {
      const invites = await guild.invites.fetch();
      invitesCache.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses])));
      console.log(`Cached ${invites.size} invites for ${guild.name}`);

      // Initialize invite counts from existing invites
      invites.forEach(invite => {
        if (invite.inviter && invite.uses > 0) {
          const inviterId = invite.inviter.id;
          const guildKey = `${guild.id}-${inviterId}`;
          const currentCount = inviteCounts.get(guildKey) || 0;
          inviteCounts.set(guildKey, currentCount + invite.uses);
          console.log(`Initialized ${invite.uses} invites for ${invite.inviter.tag} in ${guild.name}`);
        }
      });
    } catch (error) {
      console.error(`Could not fetch invites for ${guild.name}:`, error.message, error.stack);
    }
  }
});

// Track new members to update invite counts
client.on('guildMemberAdd', async (member) => {
  try {
    const guildId = member.guild.id;
    const cachedInvites = invitesCache.get(guildId) || new Map();
    const newInvites = await member.guild.invites.fetch();
    
    // Update cache with new invite usages
    const updatedInvites = new Map(newInvites.map(inv => [inv.code, inv.uses]));
    invitesCache.set(guildId, updatedInvites);

    // Find the used invite
    let usedInvite = null;
    for (const [code, uses] of updatedInvites) {
      const cachedUses = cachedInvites.get(code) || 0;
      if (uses > cachedUses) {
        usedInvite = newInvites.find(inv => inv.code === code);
        break;
      }
    }

    if (usedInvite && usedInvite.inviter) {
      const inviterId = usedInvite.inviter.id;
      const guildKey = `${guildId}-${inviterId}`;
      const count = inviteCounts.get(guildKey) || 0;
      inviteCounts.set(guildKey, count + 1);
      userInviter.set(member.id, inviterId);
      
      console.log(`[guildMemberAdd] ${member.user.tag} joined via invite from ${usedInvite.inviter.tag} (code: ${usedInvite.code}, uses: ${usedInvite.uses})`);
    } else {
      console.log(`[guildMemberAdd] Could not determine invite used by ${member.user.tag}`);
    }
  } catch (err) {
    console.error('Error in guildMemberAdd:', err.message, err.stack);
  }
});

// Handle member leaving without decrementing invite counts
client.on('guildMemberRemove', async (member) => {
  try {
    const inviterId = userInviter.get(member.id);
    if (inviterId) {
      console.log(`[guildMemberRemove] ${member.user.tag} left, invite count for ${inviterId} remains unchanged.`);
    }
  } catch (err) {
    console.error('Error in guildMemberRemove:', err.message, err.stack);
  }
});

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Check your current invite count'),
  
  new SlashCommandBuilder()
    .setName('resetinvites')
    .setDescription('Reset all invite counts (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
];

// Handle slash command interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, user } = interaction;

  try {
    switch (commandName) {
      case 'invite':
        await handleInviteCommand(interaction);
        break;
      case 'resetinvites':
        await handleResetCommand(interaction);
        break;
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error.message, error.stack);
    
    const errorMessage = {
      content: '❌ An error occurred while processing your command.',
      ephemeral: true
    };
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
    }
  }
});

async function handleInviteCommand(interaction) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const guildKey = `${guildId}-${userId}`;
  const count = inviteCounts.get(guildKey) || 0;

  const embed = new EmbedBuilder()
    .setColor(0x00ff99)
    .setTitle('📨 Your Invite Count')
    .setDescription(`You have **${count}** successful invite${count !== 1 ? 's' : ''} on this server!`)
    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
    .setFooter({ 
      text: 'Keep inviting friends to grow the community!',
      iconURL: interaction.guild.iconURL({ dynamic: true })
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });

  // Auto-delete after 60 seconds
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (error) {
      // Reply might already be deleted or expired
    }
  }, 60000);
}

async function handleResetCommand(interaction) {
  // Check for administrator permissions
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    await interaction.reply({
      content: '❌ You need Administrator permissions to reset invite counts.',
      ephemeral: true
    });
    return;
  }

  const guildId = interaction.guildId;
  
  // Remove all invite counts for this guild
  const keysToDelete = [];
  for (const key of inviteCounts.keys()) {
    if (key.startsWith(`${guildId}-`)) {
      keysToDelete.push(key);
    }
  }
  
  keysToDelete.forEach(key => inviteCounts.delete(key));
  
  // Clear user inviter mappings for this guild's members
  const membersToRemove = [];
  for (const [memberId, inviterId] of userInviter.entries()) {
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (member) {
      membersToRemove.push(memberId);
    }
  }
  
  membersToRemove.forEach(memberId => userInviter.delete(memberId));

  const embed = new EmbedBuilder()
    .setColor(0xff6b6b)
    .setTitle('🔄 Invite Counts Reset')
    .setDescription(`All invite counts for **${interaction.guild.name}** have been reset to 0.`)
    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
    .setFooter({ 
      text: `Reset by ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    })
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
  
  console.log(`Invite counts reset for guild ${interaction.guild.name} by ${interaction.user.tag}`);
}

// Initialize Express server
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Bot is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Error handling
client.on('error', error => {
  console.error('Discord client error:', error.message, error.stack);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error.message, error.stack);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('Failed to login to Discord:', error.message, error.stack);
  process.exit(1);
});
